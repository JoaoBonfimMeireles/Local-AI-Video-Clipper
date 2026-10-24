// VOD da Twitch de qualquer canal, só pela URL: metadados (yt-dlp), replay do chat (GQL pública da Twitch)
// e áudio (yt-dlp, formato audio_only). Tudo é agregado em janelas de 5 s sem guardar o chat em memória.
//
// Por que a GQL para o chat: é a fonte que o próprio site (e o TwitchDownloader) usa, não pede login para VODs
// públicos e devolve o horário de cada mensagem relativo ao vídeo. O "rechat" do yt-dlp usava a API v5, que a
// Twitch desligou; o chat-downloader está sem manutenção. Se a Twitch mudar a GQL, o erro aparece claro.
import fs from 'node:fs';
import path from 'node:path';
import { addMessage, emptyBin, pickVodMoments, scoreBins, VOD_BIN_SECONDS, type VodBin } from '@clipper/clip-selection';
import { formatTimestamp, type Job } from '@clipper/shared';
import { addJobLog, dataPaths, renameJob, resolveBinary, resolvePythonBinary, runProcess, setJobResult, updateJobProgress } from '@clipper/shared/server';
import { runFfmpeg } from '@clipper/video-processing';

type Log = (level: 'info' | 'warn', msg: string) => void;

export interface VodMeta {
  id: string;
  url: string;
  title: string;
  channel: string;
  duration: number;
}

/** "https://www.twitch.tv/videos/123" (com ou sem www/m., parâmetros, "v123") → "123". */
export function parseVodUrl(input: string): string | null {
  const m = /(?:^|twitch\.tv\/(?:[^/]+\/)?videos?\/|^v)(\d{6,12})(?:\D|$)/i.exec(input.trim());
  return m ? m[1] : null;
}

const YTDLP_ERRORS: [RegExp, string][] = [
  [/subscriber|sub-only|only available to subscribers/i, 'Este VOD é só para inscritos do canal; não dá para analisar sem ser inscrito.'],
  [/does not exist|not found|404|has been deleted|unavailable|private/i, 'VOD não encontrado: foi apagado, expirou ou é privado.'],
  [/geo|country/i, 'Este VOD está bloqueado para a sua região.'],
];

async function ytdlp(args: string[], opts: { signal?: AbortSignal; timeoutMs?: number; onStderrLine?: (l: string) => void } = {}) {
  const r = await runProcess(resolvePythonBinary(), ['-m', 'yt_dlp', '--no-warnings', '--no-playlist', ...args], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 120_000,
    onStderrLine: opts.onStderrLine,
  });
  if (r.code !== 0) {
    const err = r.stderrTail.trim();
    const known = YTDLP_ERRORS.find(([re]) => re.test(err));
    throw new Error(known ? known[1] : `yt-dlp falhou: ${err.split('\n').pop()?.slice(0, 300)}`);
  }
  return r.stdout;
}

export async function fetchVodMeta(url: string, signal?: AbortSignal): Promise<VodMeta> {
  const id = parseVodUrl(url);
  if (!id) throw new Error('URL inválida. Use o link de um VOD, como https://www.twitch.tv/videos/123456789');
  const json = JSON.parse(await ytdlp(['-J', '--skip-download', `https://www.twitch.tv/videos/${id}`], { signal }));
  if (!json.duration) throw new Error('A Twitch não informou a duração deste VOD (ainda está ao vivo ou processando?).');
  return { id, url: `https://www.twitch.tv/videos/${id}`, title: json.title ?? `VOD ${id}`, channel: json.uploader ?? json.uploader_id ?? json.channel ?? '', duration: json.duration };
}

// ---------------- Chat (GQL) ----------------

const GQL = 'https://gql.twitch.tv/gql';
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const COMMENTS_HASH = 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a';

// Só por horário: a paginação por cursor passou a exigir "integrity token" (recusada sem navegador)
async function commentsPage(videoID: string, offset: number, signal?: AbortSignal) {
  const variables = { videoID, contentOffsetSeconds: Math.floor(offset) };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(GQL, {
      method: 'POST',
      headers: { 'Client-Id': CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ operationName: 'VideoCommentsByOffsetOrCursor', variables, extensions: { persistedQuery: { version: 1, sha256Hash: COMMENTS_HASH } } }]),
      signal,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Chat: HTTP ${res.status} da Twitch`);
    const json = (await res.json()) as any;
    const video = json?.[0]?.data?.video;
    if (json?.[0]?.errors?.length) throw new Error(`Chat: a Twitch recusou a consulta (${json[0].errors[0].message}). O formato da API pode ter mudado.`);
    if (!video) throw new Error('Chat: VOD não encontrado (apagado ou só para inscritos).');
    const c = video.comments;
    return {
      comments: ((c?.edges ?? []) as any[]).map((e) => ({
        id: e.node.id as string,
        offset: e.node.contentOffsetSeconds as number,
        text: ((e.node.message?.fragments ?? []) as any[]).map((f) => f.text ?? '').join(''),
      })),
      hasNext: !!c?.pageInfo?.hasNextPage,
    };
  }
}

/**
 * Replay completo do chat agregado em janelas de 5 s. Baixa em paralelo por blocos de 30 min (cada bloco
 * avança pelo horário das mensagens), contando só as mensagens do seu intervalo — sem duplicar
 * nas bordas e sem guardar mensagens.
 */
export async function fetchChatBins(meta: VodMeta, opts: { log: Log; signal?: AbortSignal; concurrency?: number }): Promise<{ bins: VodBin[]; total: number }> {
  const nBins = Math.ceil(meta.duration / VOD_BIN_SECONDS);
  const bins = Array.from({ length: nBins }, (_, i) => emptyBin(i * VOD_BIN_SECONDS));
  const CHUNK = 1800;
  const chunks = Array.from({ length: Math.ceil(meta.duration / CHUNK) }, (_, i) => ({ a: i * CHUNK, b: Math.min(meta.duration, (i + 1) * CHUNK) }));
  let total = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const ch = chunks.shift();
      if (!ch) return;
      // Cada pedido começa no segundo da última mensagem recebida; ids já vistos (mesmo segundo) não contam de novo
      let offset = ch.a;
      let seen = new Set<string>();
      while (offset < ch.b) {
        const page = await commentsPage(meta.id, offset, opts.signal);
        const fresh = new Set<string>();
        let last = offset;
        for (const c of page.comments) {
          last = Math.max(last, c.offset);
          if (c.offset < ch.a || c.offset >= ch.b || seen.has(c.id)) continue;
          fresh.add(c.id);
          addMessage(bins[Math.min(nBins - 1, Math.floor(c.offset / VOD_BIN_SECONDS))], c.text);
          total++;
        }
        if (!page.hasNext || !page.comments.length) break;
        // Página inteira no mesmo segundo (chat muito rápido): avança 1 s para não travar
        offset = Math.floor(last) > Math.floor(offset) ? Math.floor(last) : Math.floor(offset) + 1;
        // Só os ids do segundo em que o próximo pedido começa podem repetir
        seen = new Set(page.comments.filter((c) => Math.floor(c.offset) === offset && (fresh.has(c.id) || seen.has(c.id))).map((c) => c.id));
      }
      done++;
      if (done % 4 === 0 || !chunks.length) opts.log('info', `Chat: ${Math.round((done / Math.ceil(meta.duration / CHUNK)) * 100)}% (${total.toLocaleString('pt-BR')} mensagens)`);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
  return { bins, total };
}

// ---------------- Áudio ----------------

/** Baixa só o áudio do VOD (formato audio_only da Twitch; cai para o menor formato se não houver). */
export async function downloadVodAudio(meta: VodMeta, dir: string, opts: { log: Log; signal?: AbortSignal }): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).find((f) => f.startsWith('audio.') && !f.endsWith('.part'));
  if (existing) return path.join(dir, existing);
  await ytdlp(['-f', 'audio_only/bestaudio/worst', '--concurrent-fragments', '8', '--newline', '-o', path.join(dir, 'audio.%(ext)s'), meta.url], {
    signal: opts.signal,
    timeoutMs: 4 * 3600_000,
  }).catch((e) => {
    throw new Error(`Áudio: ${(e as Error).message}`);
  });
  const file = fs.readdirSync(dir).find((f) => f.startsWith('audio.') && !f.endsWith('.part'));
  if (!file) throw new Error('Áudio: o yt-dlp não gerou o arquivo.');
  opts.log('info', `Áudio baixado (${(fs.statSync(path.join(dir, file)).size / 1e6).toFixed(0)} MB)`);
  return path.join(dir, file);
}

/** Volume RMS (dBFS) por janela de 5 s, lido em streaming do FFmpeg (memória constante, mesmo em VODs de 10 h). */
export async function audioRmsBins(file: string, bins: VodBin[], signal?: AbortSignal): Promise<void> {
  const rate = 8000;
  let i = 0;
  await runProcess(
    resolveBinary('ffmpeg'),
    ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af', `aresample=${rate},asetnsamples=n=${rate * VOD_BIN_SECONDS}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`, '-f', 'null', '-'],
    {
      signal,
      timeoutMs: 4 * 3600_000,
      captureStdout: false,
      onStdoutLine: (line) => {
        const m = /RMS_level=(-?[\d.]+|-inf)/.exec(line);
        if (!m) return;
        if (bins[i]) bins[i].rms = m[1] === '-inf' ? -90 : Math.max(-90, Number(m[1]));
        i++;
      },
    },
  );
}

// ---------------- Jobs do worker ----------------

/** Margem (s) antes/depois de cada momento aprovado: a IA do pipeline ajusta o corte fino dentro dela. */
export const VOD_SECTION_MARGIN = 15;

export function vodDir(vodId: string): string {
  return path.join(dataPaths.root, 'vods', vodId);
}

/**
 * Job "analisar VOD": chat + áudio → 15 melhores momentos em data/vods/<id>/peaks.json. Guarda também os
 * parâmetros do formulário, que a aprovação reaproveita para o job de cortes.
 */
export async function runVodAnalysis(job: Job, signal: AbortSignal): Promise<string> {
  const log: Log = (level, msg) => {
    addJobLog(job.id, level, msg);
    console.log(`[vod ${job.id.slice(0, 8)}] ${msg}`);
  };
  const progress = (step: string, p: number) => updateJobProgress(job.id, step, p);
  progress('ingest', 0.02);
  const meta = await fetchVodMeta(job.settings.vodAnalysis!.url, signal);
  renameJob(job.id, `${meta.channel} — ${meta.title}`);
  log('info', `VOD ${meta.id}: "${meta.title}" — ${meta.channel} — ${formatTimestamp(meta.duration)}`);
  const dir = vodDir(meta.id);
  fs.mkdirSync(dir, { recursive: true });

  progress('ingest', 0.1);
  const chatCache = path.join(dir, 'chat-bins.json');
  let bins: VodBin[];
  if (fs.existsSync(chatCache)) {
    bins = JSON.parse(fs.readFileSync(chatCache, 'utf8'));
    log('info', `Chat reaproveitado do cache (${bins.reduce((a, b) => a + b.msgs, 0).toLocaleString('pt-BR')} mensagens)`);
  } else {
    log('info', 'Baixando o replay do chat…');
    const r = await fetchChatBins(meta, { log, signal });
    bins = r.bins;
    fs.writeFileSync(chatCache, JSON.stringify(bins));
    log('info', `Chat: ${r.total.toLocaleString('pt-BR')} mensagens`);
  }

  progress('transcribe', 0.4);
  log('info', 'Baixando só o áudio do VOD (o vídeo não é baixado)…');
  const audio = await downloadVodAudio(meta, dir, { log, signal });
  progress('frames', 0.75);
  log('info', 'Medindo a energia do áudio…');
  await audioRmsBins(audio, bins, signal);

  progress('select', 0.9);
  const scores = scoreBins(bins, { hasAudio: true });
  const moments = pickVodMoments(bins, scores, { count: 15, duration: meta.duration });
  const { vodAnalysis: _omit, ...settings } = job.settings;
  fs.writeFileSync(
    path.join(dir, 'peaks.json'),
    JSON.stringify({
      meta,
      binSeconds: VOD_BIN_SECONDS,
      generatedAt: new Date().toISOString(),
      analysisJobId: job.id,
      settings,
      moments,
      series: scores.map((s) => ({ t: s.t, s: +s.score.toFixed(3), c: +s.chat.toFixed(2), r: +s.react.toFixed(2), a: +s.audio.toFixed(2) })),
    }),
  );
  // O áudio só serve para a análise: libera o espaço
  fs.rmSync(audio, { force: true });
  setJobResult(job.id, { vodId: meta.id });
  for (const m of moments.slice(0, 5)) log('info', `#${m.rank} ${formatTimestamp(m.start)}–${formatTimestamp(m.end)} · nota ${m.score} · ${m.typeLabel} ${m.emotes.join(' ')}`);
  log('info', `${moments.length} momentos encontrados. Revise e aprova em /vods/${meta.id}`);
  progress('export', 1);
  return meta.id;
}

/**
 * Antes do pipeline de um job de cortes de VOD: baixa só os trechos aprovados (yt-dlp --download-sections,
 * com margem) e junta tudo no arquivo de entrada do job. Se o arquivo já existe (retomada), não baixa de novo.
 */
export async function prepareVodSource(job: Job, signal: AbortSignal): Promise<void> {
  if (fs.existsSync(job.inputPath)) return;
  const src = job.settings.vodSource!;
  const log: Log = (level, msg) => addJobLog(job.id, level, msg);
  updateJobProgress(job.id, 'ingest', 0.01);
  const work = path.join(dataPaths.temp, `vod-${job.id}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  log('info', `Baixando ${src.sections.length} trecho(s) do VOD ${src.vodId} (só as partes aprovadas, em vídeo)…`);
  const files: string[] = [];
  for (const [i, sec] of src.sections.entries()) {
    signal.throwIfAborted();
    const out = path.join(work, `sec_${String(i).padStart(2, '0')}.%(ext)s`);
    await ytdlp(
      ['-f', 'best[height<=1080]/best', '--download-sections', `*${Math.floor(sec.start)}-${Math.ceil(sec.end)}`, '--ffmpeg-location', path.dirname(resolveBinary('ffmpeg')), '--concurrent-fragments', '8', '-o', out, src.url],
      { signal, timeoutMs: 30 * 60_000 },
    );
    const file = fs.readdirSync(work).find((f) => f.startsWith(`sec_${String(i).padStart(2, '0')}.`) && !f.endsWith('.part'));
    if (!file) throw new Error(`Trecho ${i + 1}: o yt-dlp não gerou o arquivo.`);
    files.push(path.join(work, file));
    updateJobProgress(job.id, 'ingest', ((i + 1) / src.sections.length) * 0.9);
    log('info', `Trecho ${i + 1}/${src.sections.length}: ${formatTimestamp(sec.start)}–${formatTimestamp(sec.end)}${sec.label ? ` (${sec.label})` : ''}`);
  }
  // Junta os trechos (mesma origem → cópia direta; se falhar, recodifica)
  const list = path.join(work, 'list.txt');
  fs.writeFileSync(list, files.map((f) => `file '${f.split(path.sep).join('/').split("'").join("'\\''")}'`).join('\n'));
  fs.mkdirSync(path.dirname(job.inputPath), { recursive: true });
  const tmp = `${job.inputPath}.part.mp4`;
  try {
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-fflags', '+genpts', '-i', list, '-c', 'copy', '-movflags', '+faststart', tmp], { signal });
  } catch (e) {
    if (signal.aborted) throw e;
    log('warn', 'Junção direta falhou; recodificando os trechos…');
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp], { signal });
  }
  fs.renameSync(tmp, job.inputPath);
  fs.rmSync(work, { recursive: true, force: true });
  log('info', `Trechos prontos: ${path.basename(job.inputPath)} (${(fs.statSync(job.inputPath).size / 1e6).toFixed(0)} MB). Começando os cortes…`);
}
