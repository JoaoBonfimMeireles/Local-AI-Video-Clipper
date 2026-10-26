// Canal de memes: a edição é toda manual no painel (/memes). O worker só transcreve as falas (whisper),
// traduz as legendas para os idiomas padrão e renderiza o compilado no molde do canal.
import fs from 'node:fs';
import path from 'node:path';
import { createLLM, transcribe } from '@clipper/ai-providers';
import { clipLength, clipOffsets, cueKey, type AppSettings, type Job, type MemeClip, type MemeCue, type MemeProject, type Transcript } from '@clipper/shared';
import { addJobLog, dataPaths, getAppSettings, safeJoin, setJobResult, updateJobProgress } from '@clipper/shared/server';
import { chunkWords, extractAudio, probe, renderMeme } from '@clipper/video-processing';
import { translateCaptions, writeCaptionFiles } from './captions';
import { readMemeBrand, readMemeProject, writeMemeProject } from './meme-store';
import { transcriptCachePath } from './pipeline';

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void;

/** Transcrição do arquivo inteiro (com o mesmo cache global do pipeline). */
async function transcriptFor(file: string, app: AppSettings, language: string, tempDir: string, log: Log, signal: AbortSignal): Promise<Transcript> {
  const cache = transcriptCachePath(file, app.whisperModel, language);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8')) as Transcript;
  const info = await probe(file, signal);
  if (!info.hasAudio) return { language: 'pt', duration: info.duration, segments: [] };
  log('info', `Transcrevendo ${path.basename(file)} com faster-whisper (modelo ${app.whisperModel})`);
  const base = path.join(tempDir, path.parse(file).name.replace(/[^\w-]/g, '_').slice(0, 40));
  const wav = `${base}.wav`;
  await extractAudio(file, wav, { signal, duration: info.duration });
  const t = await transcribe({ audioPath: wav, outputJson: `${base}.whisper.json`, model: app.whisperModel, device: app.whisperDevice, language, threads: app.threads, signal, onLog: (m) => log('info', `whisper: ${m}`) });
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(t));
  return t;
}

/** Blocos curtos de legenda (até 4 palavras) dentro do corte, com tempos relativos ao início do corte. */
function cuesForClip(t: Transcript, c: MemeClip): MemeCue[] {
  const words = t.segments
    .flatMap((s) => s.words)
    .filter((w) => w.end > c.start + 0.05 && w.start < c.end - 0.05 && w.word.trim())
    .map((w) => ({ ...w, start: Math.max(0, w.start - c.start), end: Math.min(clipLength(c), w.end - c.start) }));
  return chunkWords(words, 4, 24).map((ch) => ({ start: ch[0].start, end: Math.min(clipLength(c), ch[ch.length - 1].end + 0.2), text: ch.map((w) => w.word.trim()).join(' ') }));
}

/** Gera (ou reaproveita) as legendas de todos os vídeos do projeto e grava no projeto. Devolve o idioma falado. */
async function ensureCues(jobId: string, p: MemeProject, app: AppSettings, language: string, tempDir: string, log: Log, signal: AbortSignal, force: boolean): Promise<string> {
  let lang = '';
  for (let i = 0; i < p.clips.length; i++) {
    const c = p.clips[i];
    const key = cueKey(c);
    updateJobProgress(jobId, 'transcribe', 0.05 + (i / p.clips.length) * 0.4);
    if (!force && p.cues[key]) continue;
    const t = await transcriptFor(safeJoin(dataPaths.input, c.file), app, language, tempDir, log, signal);
    if (t.segments.length && !lang) lang = t.language;
    p.cues[key] = cuesForClip(t, c);
  }
  return lang || (language !== 'auto' ? language : 'pt');
}

export async function runMemeJob(job: Job, signal: AbortSignal): Promise<{ rendered: number; failed: number }> {
  const forced = process.env.CLIPPER_FORCE_PROVIDER as AppSettings['aiProvider'] | undefined;
  const app = { ...getAppSettings(), ...(forced ? { aiProvider: forced } : {}) };
  const spec = job.settings.meme!;
  const log: Log = (level, msg) => {
    addJobLog(job.id, level, msg);
    console.log(`[job ${job.id.slice(0, 8)}] ${level.toUpperCase()} ${msg}`);
  };
  const project = readMemeProject(spec.projectId);
  if (!project) throw new Error(`Projeto de memes não encontrado: ${spec.projectId}`);
  if (!project.clips.length) throw new Error('O compilado não tem vídeos.');
  const tempDir = path.join(dataPaths.temp, job.id);
  fs.mkdirSync(tempDir, { recursive: true });
  const language = job.settings.sourceLanguage || 'auto';

  updateJobProgress(job.id, 'transcribe', 0.03);
  const needCues = spec.action === 'transcribe' || project.subtitles;
  const lang = needCues ? await ensureCues(job.id, project, app, language, tempDir, log, signal, spec.action === 'transcribe') : 'pt';
  // Relê antes de gravar: o editor pode ter salvo mudanças enquanto o whisper rodava
  const fresh = readMemeProject(project.id) ?? project;
  fresh.cues = { ...fresh.cues, ...project.cues };
  writeMemeProject(fresh);
  if (spec.action === 'transcribe') {
    const n = Object.values(project.cues).reduce((a, c) => a + c.length, 0);
    log('info', `Legendas prontas: ${n} bloco(s) em ${project.clips.length} vídeo(s)`);
    updateJobProgress(job.id, 'export', 1);
    return { rendered: 1, failed: 0 };
  }

  // Render
  const cues = project.clips.map((c) => (project.subtitles ? (project.cues[cueKey(c)] ?? []) : []));
  const slug = (project.title || project.name || 'meme').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').slice(0, 50) || 'meme';
  const outDir = path.join(dataPaths.output, 'memes');
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `${slug}_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`);
  log('info', `Renderizando o compilado: ${project.clips.length} vídeo(s), ${project.images.length} imagem(ns), ${project.sfx.length} efeito(s)${project.music ? ', áudio de fundo' : ''}`);
  updateJobProgress(job.id, 'render', 0.5);
  const { duration } = await renderMeme({
    project,
    brand: readMemeBrand(),
    clipPaths: project.clips.map((c) => safeJoin(dataPaths.input, c.file)),
    cues,
    output: `${base}.mp4`,
    workDir: path.join(tempDir, 'render'),
    hwAccel: app.hwAccel,
    threads: app.threads,
    signal,
    onProgress: (p) => updateJobProgress(job.id, 'render', 0.5 + p * 0.4),
  });

  // Legendas em pt/en/es/zh (tempos do compilado): a única parte com IA
  updateJobProgress(job.id, 'export', 0.92);
  const offsets = clipOffsets(project.clips);
  const all = project.clips.flatMap((c, i) => (project.cues[cueKey(c)] ?? []).map((q) => ({ start: offsets[i] + q.start, end: offsets[i] + q.end, text: q.text })));
  let captions: Record<string, string> = {};
  if (all.length) {
    const llm = (() => {
      try {
        return createLLM(app, 'translate');
      } catch (e) {
        log('warn', `${(e as Error).message} — legendas só no idioma original`);
        return null;
      }
    })();
    const tr = await translateCaptions({ llm, clips: [{ index: 0, cues: all }], sourceLang: lang, log: (l, m) => log(l, m), signal });
    const files = writeCaptionFiles(base, tr[0], []);
    captions = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, path.join(outDir, v!.srt)]));
  }
  const done = readMemeProject(project.id) ?? project;
  done.lastRender = { video: `${base}.mp4`, captions, at: new Date().toISOString(), jobId: job.id };
  writeMemeProject(done);
  setJobResult(job.id, { outputDir: outDir, language: lang });
  log('info', `Compilado pronto (${duration.toFixed(1)}s): ${base}.mp4`);
  updateJobProgress(job.id, 'export', 1);
  return { rendered: 1, failed: 0 };
}
