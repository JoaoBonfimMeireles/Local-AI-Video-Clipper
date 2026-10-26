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
import type { FrameSide, Job, LibraryIndex, ManualEdit, ManualFrame, OutputFormat, Transcript } from '@clipper/shared';
import {
  addJobLog,
  dataPaths,
  getAppSettings,
  getFavorite,
  getJob,
  listClips,
  resolveLibraryFile,
  scanLibrary,
  updateClip,
  updateFavorite,
  updateJobProgress,
} from '@clipper/shared/server';
import { analyzeAssets, buildAss, buildSrt, canvasSize, captionCues, extractThumbnail, planSoundPauses, prepareClipSource, probe, renderClip, shiftForPauses, splitTopRatio } from '@clipper/video-processing';
import { rankCardsFor } from './pipeline';
import { translateCaptions, writeCaptionFiles } from './captions';
import { cachedStyleGuide, combineGuidelines } from './references';

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

  // Origem: o corte do job ou a cópia guardada nos favoritos (que não depende mais do job)
  const fav = rev.favoriteId ? getFavorite(rev.favoriteId) : null;
  if (rev.favoriteId && !fav) throw new Error('Favorito não encontrado.');
  const parent = fav ? null : getJob(rev.parentJobId);
  if (!fav && !parent?.result?.outputDir) throw new Error('Job original não encontrado (ou sem saída).');
  const clip = parent ? listClips(parent.id).find((c) => c.index === rev.clipIndex) : null;
  const metadataPath = fav ? fav.metadataPath : clip?.metadataPath;
  if (!metadataPath || !fs.existsSync(metadataPath)) throw new Error('Corte original não encontrado.');
  const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const ctx = meta.renderContext as RenderContext;
  if (!ctx) throw new Error('Este corte foi gerado por uma versão antiga do app (sem contexto de renderização). Reprocesse o vídeo uma vez para poder ajustar.');
  if (!fs.existsSync(ctx.input)) throw new Error(`O vídeo original não está mais em ${ctx.input}; sem ele não dá para refazer o corte.`);
  const transcript: Transcript = JSON.parse(fs.readFileSync(fav ? path.join(fav.dir, 'transcript.json') : path.join(parent!.result!.outputDir!, 'transcript.json'), 'utf8'));
  const s = { ...job.settings, revision: null };
  const app = getAppSettings();
  const n = String(rev.clipIndex + 1).padStart(3, '0');
  const manual = rev.manual ?? null;
  log('info', manual ? `Edição manual do corte ${rev.clipIndex + 1} ("${meta.title}") — sem IA no plano` : `Ajustando o corte ${rev.clipIndex + 1} ("${meta.title}") — pedido: ${rev.comment.slice(0, 200)}`);

  // Edição manual não precisa de IA (só a tradução das legendas usa, se houver provedor)
  const llm = createLLM(app, 'edit');
  if (!llm && !manual) throw new Error('Ajuste por comentário precisa de um provedor de IA (Configurações).');
  if (llm) llm.onNotice = (m) => log('warn', m);
  const library = scanLibrary();
  const metaCache = path.join(dataPaths.root, 'cache', 'library-meta.json');
  const info = await probe(ctx.input, signal);
  const { segments, resolved, changes } = manual ? planFromManual(manual, meta, info.duration, library, job.id, rev.clipIndex) : await planFromComment();
  const duration = segments.reduce((a, sg) => a + (sg.end - sg.start), 0);
  for (const w of resolved.warnings) log('warn', w);
  if (changes) log('info', manual ? changes : `IA: ${changes}`);
  // Layout facecam: "tamanho do rosto" = recortar a câmera mais apertada em volta do centro
  const layout = manual?.camZoom && ctx.layout?.cam ? { ...ctx.layout, cam: zoomBox(ctx.layout.cam, manual.camZoom) } : ctx.layout;

  async function planFromComment() {

  // Catálogo pequeno: memes/sons cujo nome combina com o corte E com o pedido
  progress(0.1);
  const shortlist = shortlistLibrary(library, [meta.title, meta.transcript ?? '', rev.comment], { memes: s.useMemes ? 50 : 0, images: 0, audio: s.useSfx ? 40 : 0 }, job.id);
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
    llm!,
    {
      system: withGuidelines(REVISION_SYSTEM, combineGuidelines(app.editingPrompt, app.useReferences ? cachedStyleGuide() : null)),
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
  // Novos trechos (se o pedido mudou começo/fim) — sempre dentro do vídeo
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
  return { segments, resolved: resolveEdit(normalized, library, `${job.id}:${rev.clipIndex}`), changes: revised.changes ?? null };
  }

  // Metadados (duração/áudio/fundo verde) dos memes escolhidos, inclusive os que vieram do plano antigo
  const memeInfo = await analyzeAssets([...resolved.overlays.map((o) => o.file), ...resolved.sfx.map((x) => x.file)], metaCache);

  // Renderização (mesmo caminho do pipeline principal)
  progress(0.35, 'render');
  const clipsDir = fav ? fav.dir : path.join(parent!.result!.outputDir!, 'clips');
  const stem = fav ? 'clip' : `clip_${n}`;
  let version = 2;
  while (fs.existsSync(path.join(clipsDir, `${stem}_v${version}.mp4`))) version++;
  const base = path.join(clipsDir, `${stem}_v${version}`);
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
        baseline: layout?.cam ? splitTopRatio({ w: (layout.cam.x1 - layout.cam.x0) * info.width, h: (layout.cam.y1 - layout.cam.y0) * info.height }, canvas.width, canvas.height) + 0.15 : undefined,
        rankCards: ctx.category === 'top5' ? rankCardsFor(segments) : undefined,
      })
    : undefined;
  const pauses = planSoundPauses(
    resolved.sfx.map((x) => ({ file: x.file, at: x.at, volume: x.volume, duration: x.duration ?? memeInfo.get(x.file)?.duration })),
    words,
    duration,
  );
  const pausedTotal = pauses.reduce((a, p) => a + p.duration, 0);
  let input = ctx.input;
  let start = segments[0].start;
  if (segments.length > 1 || ctx.inpaintRegion) {
    input = path.join(workDir, 'source.mp4');
    start = 0;
    await prepareClipSource({ input: ctx.input, segments, source: info, subtitleRegion: ctx.inpaintRegion, output: input, workDir, signal, onProgress: (p) => progress(0.35 + p * 0.3, 'render') });
  }
  const renderArgs: Parameters<typeof renderClip>[0] = {
    input,
    start,
    end: start + duration,
    source: input === ctx.input ? info : { ...info, hasAudio: true },
    format: ctx.format,
    flashAt: segments.length > 1 ? segments.slice(0, -1).reduce<number[]>((acc, sg) => [...acc, (acc[acc.length - 1] ?? 0) + sg.end - sg.start], []) : [],
    shots: resolved.shots,
    cleanArea: ctx.cleanArea,
    split: layout?.cam ? { cam: layout.cam } : null,
    content: layout?.content ?? null,
    bubble: layout?.bubble ?? null,
    contentPhases: layout?.contentPhases ?? null,
    // Enquadramento desenhado no editor manual (substitui o da IA)
    manualFrames: withSceneFiles((manual ? manual.frames : meta.edit?.frames)?.length ? (manual ? manual.frames : meta.edit.frames) : null, ctx.input),
    zooms: resolved.zooms,
    overlays: resolved.overlays.map((o) => {
      const inf = memeInfo.get(o.file);
      const dur = inf && inf.duration > 0 ? Math.min(Math.max(o.duration, Math.min(inf.duration, 6)), inf.duration) : o.duration;
      return { file: o.file, at: o.at, duration: dur, position: o.position, scale: o.scale, hasAudio: inf?.hasAudio, volume: 0.9, greenScreen: inf?.greenScreen, keyColor: inf?.keyColor, audioMode: o.audioMode };
    }),
    // Sons com o vídeo pausado (não atropelam a fala)
    pauses,
    sfx: [],
    assContent: ass,
    output: `${base}.mp4`,
    workDir,
    hwAccel: app.hwAccel,
    threads: app.threads,
    signal,
    onProgress: (p) => progress(0.5 + p * 0.25, 'render'),
  };
  await renderClip(renderArgs);
  await extractThumbnail(`${base}.mp4`, `${base}.jpg`, Math.min(1.5, duration / 2)).catch(() => undefined);

  // Legendas em 4 idiomas + versão com legenda em mandarim (igual ao corte principal)
  const cards = ctx.category === 'top5' ? rankCardsFor(segments) : undefined;
  const captions = (
    await translateCaptions({
      llm,
      clips: [{ index: 0, cues: captionCues(words), labels: cards?.map((r) => r.label) ?? [] }],
      sourceLang: transcript.language,
      guidelines: app.editingPrompt,
      signal,
      log: (l, m) => log(l, m),
    })
  )[0];
  let videoZh: string | null = null;
  if (s.burnSubtitles && captions?.cues.zh?.length) {
    try {
      const zhLabels = captions.labels.zh ?? [];
      const zhAss = buildAss([], {
        width: canvas.width,
        height: canvas.height,
        intensity: s.intensity,
        baseline: layout?.cam ? splitTopRatio({ w: (layout.cam.x1 - layout.cam.x0) * info.width, h: (layout.cam.y1 - layout.cam.y0) * info.height }, canvas.width, canvas.height) + 0.15 : undefined,
        rankCards: cards?.map((r, i) => ({ ...r, label: zhLabels[i] || r.label })),
        cues: captions.cues.zh,
        font: 'Microsoft YaHei',
        topTitle: '精彩时刻',
      });
      await renderClip({ ...renderArgs, assContent: zhAss, output: `${base}.zh.mp4`, onProgress: (p) => progress(0.75 + p * 0.22, 'render') });
      videoZh = `${base}.zh.mp4`;
    } catch (e) {
      if (signal.aborted) throw e;
      log('warn', `Versão em mandarim falhou: ${(e as Error).message}`);
    }
  }
  const subtitleFiles = writeCaptionFiles(base, captions, pauses);
  const srtPath = s.exportSrt ? `${base}.srt` : null;
  if (srtPath) fs.writeFileSync(srtPath, buildSrt(shiftForPauses(words, pauses)), 'utf8');

  const title = resolved.title || meta.title;
  const newMeta = {
    ...meta,
    title,
    description: resolved.description ?? meta.description,
    hashtags: resolved.hashtags.length ? resolved.hashtags : meta.hashtags,
    duration: Number((duration + pausedTotal).toFixed(3)),
    source: { ...meta.source, start: Math.min(...segments.map((x) => x.start)), end: Math.max(...segments.map((x) => x.end)), segments },
    // Pausas inseridas para os sons (tempo do plano, sem pausas): o editor manual converte para o tempo do vídeo
    soundPauses: pauses.map((p) => ({ at: p.at, duration: p.duration })),
    edit: {
      shots: resolved.shots,
      zooms: resolved.zooms,
      overlays: resolved.overlays.map((o) => ({ ...o, file: o.fileName })),
      sfx: resolved.sfx.map((x) => ({ ...x, file: x.fileName })),
      emphasisWords: resolved.emphasisWords,
      frames: (manual ? manual.frames : meta.edit?.frames)?.length ? (manual ? manual.frames : meta.edit.frames) : null,
    },
    renderContext: { ...ctx, segments },
    revision: { version, comment: manual ? 'Edição manual' : rev.comment, changes, previous: path.basename((fav ? fav.videoPath : clip?.outputPath) ?? '') },
    files: {
      video: path.basename(`${base}.mp4`),
      videoZh: videoZh ? path.basename(videoZh) : null,
      thumbnail: path.basename(`${base}.jpg`),
      srt: srtPath ? { [transcript.language]: path.basename(srtPath) } : {},
      subtitles: subtitleFiles,
    },
    transcript: words.map((w) => w.word).join(' '),
    renderedAt: new Date().toISOString(),
  };
  fs.writeFileSync(`${base}.json`, JSON.stringify(newMeta, null, 2), 'utf8');
  if (fav) {
    // O favorito passa a mostrar a nova versão (as anteriores continuam na pasta dele)
    updateFavorite(fav.id, { videoPath: `${base}.mp4`, srtPath, metadataPath: `${base}.json`, title, description: newMeta.description ?? null, hashtags: newMeta.hashtags ?? [], duration: newMeta.duration });
  } else {
    // O corte do job original passa a apontar para a nova versão (a anterior continua na pasta)
    updateClip(parent!.id, rev.clipIndex, {
      status: 'completed',
      outputPath: `${base}.mp4`,
      srtPath,
      metadataPath: `${base}.json`,
      title,
      description: newMeta.description ?? null,
      hashtags: newMeta.hashtags ?? [],
    });
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* limpeza na próxima inicialização */
  }
  log('info', `✔ ${path.basename(base)}.mp4 pronto (${duration.toFixed(1)}s) ${llm?.usage.inputTokens ? ` — ${llm.usage.inputTokens.toLocaleString('pt-BR')} tokens de entrada` : ''}`);
  progress(1, 'export');
  return { rendered: 1, failed: 0 };
}

/** Plano da edição manual → plano resolvido (só arquivos que existem na biblioteca), sem limites da IA. */
function planFromManual(m: ManualEdit, meta: any, videoDuration: number, library: LibraryIndex, seed: string, clipIndex: number) {
  const segments: ClipSegment[] = m.segments
    .map((sg) => ({ start: Math.max(0, sg.start), end: Math.min(videoDuration, sg.end), label: sg.label ?? null }))
    .filter((sg) => sg.end > sg.start + 0.5);
  if (!segments.length) throw new Error('Edição manual sem nenhum trecho válido.');
  const duration = segments.reduce((a, sg) => a + (sg.end - sg.start), 0);
  const inside = <T extends { at: number }>(x: T) => x.at >= 0 && x.at < duration - 0.1;
  const edit = {
    clipIndex,
    illustrations: [],
    shots: normalizeShots(m.shots.filter(inside), duration),
    zooms: m.zooms.filter(inside).map((z) => ({ ...z, duration: Math.min(z.duration, duration - z.at) })),
    overlays: m.overlays.filter(inside).map((o) => ({ ...o, duration: Math.min(o.duration, duration - o.at) })),
    sfx: m.sfx.filter(inside),
    emphasisWords: meta.edit?.emphasisWords ?? [],
    title: meta.title,
    description: meta.description ?? undefined,
    hashtags: meta.hashtags ?? [],
  } as unknown as ClipEdit;
  const resolved = resolveEdit(edit, library, `${seed}:${clipIndex}`);
  const changed = segments.length !== (meta.renderContext?.segments?.length ?? 0) || segments.some((sg, i) => sg.start !== meta.renderContext.segments[i]?.start || sg.end !== meta.renderContext.segments[i]?.end);
  return {
    segments,
    resolved,
    changes: `Edição manual: ${resolved.overlays.length} meme(s)/imagem(ns), ${resolved.sfx.length} som(ns), ${resolved.zooms.length} zoom(s)${changed ? `, trechos ${segments.map((sg) => `${sg.start.toFixed(1)}–${sg.end.toFixed(1)}s`).join(' + ')}` : ''}${m.camZoom && m.camZoom !== 1 ? `, rosto ${m.camZoom.toFixed(2)}x` : ''}`,
  };
}

/** Recorta a caixa (frações 0-1) em volta do centro: zoom 1.3 = mostra 1/1.3 da largura e da altura. */
function zoomBox(b: { x0: number; y0: number; x1: number; y1: number }, zoom: number) {
  const z = Math.min(3, Math.max(0.5, zoom));
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const hw = Math.min(0.5, (b.x1 - b.x0) / 2 / z);
  const hh = Math.min(0.5, (b.y1 - b.y0) / 2 / z);
  const clamp = (v: number, h: number) => Math.min(1 - h, Math.max(h, v));
  const x = clamp(cx, hw);
  const y = clamp(cy, hh);
  return { ...b, x0: x - hw, x1: x + hw, y0: y - hh, y1: y + hh };
}

/** "Outra cena" ao lado vem do vídeo original: o editor não guarda o caminho dele, o render precisa. */
function withSceneFiles(frames: ManualFrame[] | null, original: string): ManualFrame[] | null {
  if (!frames) return null;
  const fix = (sd?: FrameSide | null) => (sd?.kind === 'scene' ? { ...sd, file: original } : sd);
  return frames.map((fr) => ({ ...fr, sideTop: fix(fr.sideTop), sideBottom: fix(fr.sideBottom) }));
}
