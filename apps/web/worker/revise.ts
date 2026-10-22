// Ajuste de UM corte já pronto a partir de um comentário do editor.
// Não reprocessa o vídeo: reaproveita transcrição, layout e plano salvos no metadata do corte e faz
// uma única chamada de IA pequena (plano atual + comentário + catálogo pré-selecionado).
import fs from 'node:fs';
import path from 'node:path';
import { askJson, createLLM, wordsToTimedText } from '@clipper/ai-providers';
import { wordsForSegments, type ClipSegment } from '@clipper/clip-selection';
import {
  buildCatalog,
  buildRevisionPrompt,
  normalizeEdit,
  normalizeShots,
  resolveEdit,
  REVISION_SYSTEM,
  RevisionSchema,
  shortlistLibrary,
  withGuidelines,
  type AssetMeta,
  type ClipEdit,
  type ClipLayout,
} from '@clipper/editing-planner';
import type { Job, OutputFormat, Transcript } from '@clipper/shared';
import {
  addJobLog,
  dataPaths,
  getAppSettings,
  getJob,
  listClips,
  resolveLibraryFile,
  scanLibrary,
  updateClip,
  updateJobProgress,
} from '@clipper/shared/server';
import { analyzeAssets, buildAss, buildSrt, canvasSize, extractThumbnail, prepareClipSource, probe, renderClip } from '@clipper/video-processing';
import { rankCardsFor } from './pipeline';

interface RenderContext {
  input: string;
  format: OutputFormat;
  cleanArea: { y0: number; y1: number } | null;
  inpaintRegion: { y: number; h: number } | null;
  layout: ClipLayout | null;
  category: string | null;
  segments: ClipSegment[];
}

export async function runRevision(job: Job, signal: AbortSignal): Promise<{ rendered: number; failed: number }> {
  const rev = job.settings.revision!;
  const log = (level: 'info' | 'warn' | 'error', msg: string) => {
    addJobLog(job.id, level, msg);
    console.log(`[ajuste ${job.id.slice(0, 8)}] ${level.toUpperCase()} ${msg}`);
  };
  const progress = (p: number, step = 'plan') => updateJobProgress(job.id, step, p);

  const parent = getJob(rev.parentJobId);
  if (!parent?.result?.outputDir) throw new Error('Job original não encontrado (ou sem saída).');
  const clip = listClips(parent.id).find((c) => c.index === rev.clipIndex);
  if (!clip?.metadataPath || !fs.existsSync(clip.metadataPath)) throw new Error('Corte original não encontrado.');
  const meta = JSON.parse(fs.readFileSync(clip.metadataPath, 'utf8'));
  const ctx: RenderContext | undefined = meta.renderContext;
  if (!ctx) throw new Error('Este corte foi gerado por uma versão antiga do app (sem contexto de renderização). Reprocesse o vídeo uma vez para poder ajustar.');
  const transcript: Transcript = JSON.parse(fs.readFileSync(path.join(parent.result.outputDir, 'transcript.json'), 'utf8'));
  const s = parent.settings;
  const app = getAppSettings();
  const n = String(rev.clipIndex + 1).padStart(3, '0');
  log('info', `Ajustando o corte ${rev.clipIndex + 1} ("${meta.title}") — pedido: ${rev.comment.slice(0, 200)}`);

  const llm = createLLM(app, 'edit');
  if (!llm) throw new Error('Ajuste por comentário precisa de um provedor de IA (Configurações).');
  llm.onNotice = (m) => log('warn', m);

  // Catálogo pequeno: memes/sons cujo nome combina com o corte E com o pedido
  progress(0.1);
  const library = scanLibrary();
  const shortlist = shortlistLibrary(library, [meta.title, meta.transcript ?? '', rev.comment], { memes: s.useMemes ? 50 : 0, images: 0, audio: s.useSfx ? 40 : 0 }, job.id);
  const metaCache = path.join(dataPaths.root, 'cache', 'library-meta.json');
  const refs = (['memes', 'audio'] as const).flatMap((kind) => shortlist[kind].flatMap((c) => c.files.map((file) => ({ kind, cat: c.name, file, full: resolveLibraryFile(library, kind, c.name, file) }))));
  const infos = await analyzeAssets(refs.filter((r) => r.full).map((r) => r.full!), metaCache);
  const assetMeta: AssetMeta = {};
  for (const r of refs) {
    const inf = r.full ? infos.get(r.full) : undefined;
    if (inf) assetMeta[`${r.kind}/${r.cat}/${r.file}`] = { duration: inf.duration, hasAudio: inf.hasAudio, greenScreen: inf.greenScreen };
  }
  shortlist.audio = shortlist.audio.map((c) => ({ ...c, files: c.files.filter((f) => (assetMeta[`audio/${c.name}/${f}`]?.duration ?? 0) <= 8) })).filter((c) => c.files.length);
  const catalog = buildCatalog(shortlist, assetMeta);

  const oldWords = wordsForSegments(transcript, ctx.segments);
  const currentPlan = {
    shots: meta.edit?.shots ?? [],
    zooms: meta.edit?.zooms ?? [],
    overlays: (meta.edit?.overlays ?? []).map((o: any) => ({ type: o.type, file: o.file, at: o.at, duration: o.duration, position: o.position, scale: o.scale, audioMode: o.audioMode })),
    sfx: (meta.edit?.sfx ?? []).map((x: any) => ({ file: x.file, at: x.at, volume: x.volume, duration: x.duration })),
    emphasisWords: meta.edit?.emphasisWords ?? [],
    title: meta.title,
    description: meta.description ?? '',
    hashtags: meta.hashtags ?? [],
  };
  progress(0.2);
  const revised = await askJson(
    llm,
    {
      system: withGuidelines(REVISION_SYSTEM, app.editingPrompt),
      prompt: buildRevisionPrompt({
        comment: rev.comment,
        currentPlan,
        segments: ctx.segments,
        duration: meta.duration,
        transcript: wordsToTimedText(oldWords),
        catalog: catalog.text,
        language: app.postLanguage || transcript.language,
      }),
      signal,
    },
    RevisionSchema,
    (l, m) => log(l, m),
  );
  if (revised.changes) log('info', `IA: ${revised.changes}`);

  // Novos trechos (se o pedido mudou começo/fim) — sempre dentro do vídeo
  const info = await probe(ctx.input, signal);
  const segments: ClipSegment[] = revised.segments?.length
    ? revised.segments.map((sg) => ({ start: Math.max(0, sg.start), end: Math.min(info.duration, sg.end), label: sg.label ?? null })).filter((sg) => sg.end > sg.start + 0.5)
    : ctx.segments;
  const duration = segments.reduce((a, sg) => a + (sg.end - sg.start), 0);
  if (revised.segments?.length) log('info', `Trechos alterados: ${segments.map((sg) => `${sg.start.toFixed(1)}–${sg.end.toFixed(1)}s`).join(' + ')} (${duration.toFixed(0)}s)`);

  // Códigos do catálogo → arquivos; nomes de arquivo do plano antigo continuam válidos
  const edit: ClipEdit = { clipIndex: rev.clipIndex, ...revised, shots: revised.shots ?? [] };
  for (const o of edit.overlays) {
    const e = o.file ? catalog.byId.get(o.file) : undefined;
    if (e) Object.assign(o, { file: e.file, category: e.category, type: 'meme' });
  }
  for (const x of edit.sfx) {
    const e = x.file ? catalog.byId.get(x.file) : undefined;
    if (e) Object.assign(x, { file: e.file, category: e.category });
  }
  const normalized = normalizeEdit(edit, duration, s);
  normalized.shots = ctx.layout?.cam || ctx.layout?.gameplay ? [] : normalizeShots(normalized.shots, duration);
  const resolved = resolveEdit(normalized, library, `${job.id}:${rev.clipIndex}`);
  for (const w of resolved.warnings) log('warn', w);
  // Metadados (duração/áudio/fundo verde) dos memes escolhidos, inclusive os que vieram do plano antigo
  const memeInfo = await analyzeAssets([...resolved.overlays.map((o) => o.file), ...resolved.sfx.map((x) => x.file)], metaCache);

  // Renderização (mesmo caminho do pipeline principal)
  progress(0.35, 'render');
  const clipsDir = path.join(parent.result.outputDir, 'clips');
  let version = 2;
  while (fs.existsSync(path.join(clipsDir, `clip_${n}_v${version}.mp4`))) version++;
  const base = path.join(clipsDir, `clip_${n}_v${version}`);
  const workDir = path.join(dataPaths.temp, job.id);
  fs.mkdirSync(workDir, { recursive: true });
  const canvas = canvasSize(ctx.format, info);
  const emphasis = new Set(resolved.emphasisWords.map((w) => w.toLowerCase()));
  const words = wordsForSegments(transcript, segments).map((w) => ({ ...w, emphasis: emphasis.has(w.word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()) }));
  const ass = s.burnSubtitles
    ? buildAss(words, {
        width: canvas.width,
        height: canvas.height,
        intensity: s.intensity,
        baseline: ctx.layout?.cam ? 0.53 : undefined,
        rankCards: ctx.category === 'top5' ? rankCardsFor(segments) : undefined,
      })
    : undefined;
  let input = ctx.input;
  let start = segments[0].start;
  if (segments.length > 1 || ctx.inpaintRegion) {
    input = path.join(workDir, 'source.mp4');
    start = 0;
    await prepareClipSource({ input: ctx.input, segments, source: info, subtitleRegion: ctx.inpaintRegion, output: input, workDir, signal, onProgress: (p) => progress(0.35 + p * 0.3, 'render') });
  }
  await renderClip({
    input,
    start,
    end: start + duration,
    source: input === ctx.input ? info : { ...info, hasAudio: true },
    format: ctx.format,
    flashAt: segments.length > 1 ? segments.slice(0, -1).reduce<number[]>((acc, sg) => [...acc, (acc[acc.length - 1] ?? 0) + sg.end - sg.start], []) : [],
    shots: resolved.shots,
    cleanArea: ctx.cleanArea,
    split: ctx.layout?.cam ? { cam: ctx.layout.cam } : null,
    zooms: resolved.zooms,
    overlays: resolved.overlays.map((o) => {
      const inf = memeInfo.get(o.file);
      const dur = inf && inf.duration > 0 ? Math.min(Math.max(o.duration, Math.min(inf.duration, 6)), inf.duration) : o.duration;
      return { file: o.file, at: o.at, duration: dur, position: o.position, scale: o.scale, hasAudio: inf?.hasAudio, volume: 0.9, greenScreen: inf?.greenScreen, keyColor: inf?.keyColor, audioMode: o.audioMode };
    }),
    sfx: resolved.sfx.map((x) => {
      const len = memeInfo.get(x.file)?.duration ?? 0;
      return { file: x.file, at: x.at, volume: x.volume, duration: x.duration ?? (len > 0 ? Math.min(len, 5) : 5) };
    }),
    assContent: ass,
    output: `${base}.mp4`,
    workDir,
    hwAccel: app.hwAccel,
    threads: app.threads,
    signal,
    onProgress: (p) => progress(0.65 + p * 0.3, 'render'),
  });
  await extractThumbnail(`${base}.mp4`, `${base}.jpg`, Math.min(1.5, duration / 2)).catch(() => undefined);
  const srtPath = s.exportSrt ? `${base}.srt` : null;
  if (srtPath) fs.writeFileSync(srtPath, buildSrt(words), 'utf8');

  const title = resolved.title || meta.title;
  const newMeta = {
    ...meta,
    title,
    description: resolved.description ?? meta.description,
    hashtags: resolved.hashtags.length ? resolved.hashtags : meta.hashtags,
    duration: Number(duration.toFixed(3)),
    source: { ...meta.source, start: Math.min(...segments.map((x) => x.start)), end: Math.max(...segments.map((x) => x.end)), segments },
    edit: {
      shots: resolved.shots,
      zooms: resolved.zooms,
      overlays: resolved.overlays.map((o) => ({ ...o, file: o.fileName })),
      sfx: resolved.sfx.map((x) => ({ ...x, file: x.fileName })),
      emphasisWords: resolved.emphasisWords,
    },
    renderContext: { ...ctx, segments },
    revision: { version, comment: rev.comment, changes: revised.changes ?? null, previous: path.basename(clip.outputPath ?? '') },
    files: { video: path.basename(`${base}.mp4`), thumbnail: path.basename(`${base}.jpg`), srt: srtPath ? { [transcript.language]: path.basename(srtPath) } : {} },
    transcript: words.map((w) => w.word).join(' '),
    renderedAt: new Date().toISOString(),
  };
  fs.writeFileSync(`${base}.json`, JSON.stringify(newMeta, null, 2), 'utf8');
  // O corte do job original passa a apontar para a nova versão (a anterior continua na pasta)
  updateClip(parent.id, rev.clipIndex, {
    status: 'completed',
    outputPath: `${base}.mp4`,
    srtPath,
    metadataPath: `${base}.json`,
    title,
    description: newMeta.description ?? null,
    hashtags: newMeta.hashtags ?? [],
  });
  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* limpeza na próxima inicialização */
  }
  log('info', `✔ clip_${n}_v${version}.mp4 pronto (${duration.toFixed(1)}s) — ${llm.usage.inputTokens.toLocaleString('pt-BR')} tokens de entrada`);
  progress(1, 'export');
  return { rendered: 1, failed: 0 };
}
