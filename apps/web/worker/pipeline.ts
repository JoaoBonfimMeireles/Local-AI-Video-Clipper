import fs from 'node:fs';
import path from 'node:path';
import {
  aiPlanEdits,
  aiSelectCandidates,
  createLLM,
  detectSubtitleRegion,
  transcribe,
  translateSegments,
  type LLMProvider,
} from '@clipper/ai-providers';
import { buildSentences, heuristicCandidates, selectClips, snapToSentences, wordsInRange, type ClipCandidate } from '@clipper/clip-selection';
import { heuristicEdit, normalizeEdit, resolveEdit, type ClipEdit, type ResolvedEdit } from '@clipper/editing-planner';
import { flattenWords, slugify, type Job, type JobResult, type PipelineStep, type ProbeInfo, type Transcript, type TranscriptWord } from '@clipper/shared';
import {
  addJobLog,
  dataPaths,
  getAppSettings,
  getJob,
  replaceClips,
  scanLibrary,
  setJobResult,
  updateClip,
  updateJobProgress,
} from '@clipper/shared/server';
import {
  analyzeEnergy,
  buildAss,
  buildSrt,
  canvasSize,
  detectSceneChanges,
  detectSilences,
  extractAudio,
  extractFrames,
  extractThumbnail,
  findEnergyPeaks,
  pickFrameTimes,
  probe,
  probeAsset,
  renderClip,
  synthesizeWords,
  validateProbe,
  type ExtractedFrame,
} from '@clipper/video-processing';

// Faixa de progresso global de cada etapa
const STEP_RANGE: Record<PipelineStep, [number, number]> = {
  ingest: [0, 0.03],
  transcribe: [0.03, 0.4],
  frames: [0.4, 0.5],
  select: [0.5, 0.57],
  plan: [0.57, 0.61],
  subtitles: [0.61, 0.65],
  render: [0.65, 0.98],
  export: [0.98, 1],
};

interface SelectedClip extends ClipCandidate {
  index: number;
}

export interface PipelineOutcome {
  rendered: number;
  failed: number;
}

/**
 * Cria um diretório de trabalho. No Windows, uma pasta com exclusão pendente (handle ainda aberto
 * por antivírus/indexador) retorna EPERM em mkdir; nesse caso usa um nome alternativo.
 */
function usableDir(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOENT') throw e;
    const alt = `${dir}_${Date.now().toString(36)}`;
    fs.mkdirSync(alt, { recursive: true });
    return alt;
  }
}

export async function runPipeline(job: Job, signal: AbortSignal): Promise<PipelineOutcome> {
  const app = getAppSettings();
  const s = job.settings;
  const tempDir = usableDir(path.join(dataPaths.temp, job.id));

  const log = (level: 'info' | 'warn' | 'error', msg: string) => {
    addJobLog(job.id, level, msg);
    console.log(`[job ${job.id.slice(0, 8)}] ${level.toUpperCase()} ${msg}`);
  };
  let lastWrite = 0;
  const progress = (step: PipelineStep, frac: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastWrite < 400) return;
    lastWrite = now;
    const [a, b] = STEP_RANGE[step];
    updateJobProgress(job.id, step, a + (b - a) * Math.max(0, Math.min(1, frac)));
  };
  const begin = (step: PipelineStep, msg: string) => {
    signal.throwIfAborted();
    progress(step, 0, true);
    log('info', msg);
  };
  /** Cache em disco por etapa: permite retomar um job após falha/reinício sem refazer tudo. */
  async function cached<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const file = path.join(tempDir, name);
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
      } catch {
        /* cache corrompido: recalcula */
      }
    }
    const value = await fn();
    fs.writeFileSync(file, JSON.stringify(value));
    return value;
  }

  // ---------------- 1. Ingestão ----------------
  begin('ingest', `Inspecionando ${path.basename(job.inputPath)} com FFprobe`);
  if (!fs.existsSync(job.inputPath)) throw new Error(`Arquivo de entrada não existe: ${job.inputPath}`);
  const info = await cached<ProbeInfo>('probe.json', () => probe(job.inputPath, signal));
  const problems = validateProbe(info);
  if (problems.length) throw new Error(problems.join(' '));
  log('info', `${info.width}x${info.height} @ ${info.fps.toFixed(2)}fps, ${info.duration.toFixed(1)}s, vídeo ${info.videoCodec}, áudio ${info.audioCodec} (${info.audioTracks} faixa(s))`);

  const result: JobResult = { ...(getJob(job.id)?.result ?? {}) };
  if (!result.outputDir) {
    let dir = path.join(dataPaths.output, slugify(job.videoName));
    if (fs.existsSync(dir)) dir = `${dir}-${job.id.slice(0, 6)}`;
    result.outputDir = dir;
  }
  const outputDir = result.outputDir;
  const clipsDir = path.join(outputDir, 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });
  setJobResult(job.id, result);

  // ---------------- 2. Transcrição ----------------
  begin('transcribe', `Transcrevendo com faster-whisper (modelo ${app.whisperModel}, dispositivo ${app.whisperDevice})`);
  const wav = path.join(tempDir, 'audio.wav');
  if (!fs.existsSync(wav)) {
    await extractAudio(job.inputPath, wav + '.part.wav', { signal, duration: info.duration, onProgress: (p) => progress('transcribe', p * 0.05) });
    fs.renameSync(wav + '.part.wav', wav);
  }
  const transcript = await cached<Transcript>('transcript.json', () =>
    transcribe({
      audioPath: wav,
      outputJson: path.join(tempDir, 'whisper-raw.json'),
      model: app.whisperModel,
      device: app.whisperDevice,
      language: s.sourceLanguage,
      threads: app.threads,
      signal,
      onProgress: (p) => progress('transcribe', 0.05 + p * 0.9),
      onLog: (m) => log('info', `whisper: ${m}`),
    }),
  );
  const wordCount = transcript.segments.reduce((a, x) => a + x.words.length, 0);
  log('info', `Transcrição: idioma ${transcript.language}, ${transcript.segments.length} segmentos, ${wordCount} palavras (${transcript.device ?? '?'})`);
  if (!transcript.segments.length) throw new Error('Nenhuma fala detectada no vídeo.');
  const energy = await cached<number[]>('energy.json', () => analyzeEnergy(wav, signal));
  const silences = await cached('silences.json', () => detectSilences(wav, { signal }));
  progress('transcribe', 1, true);

  // ---------------- 3. Amostragem visual ----------------
  begin('frames', 'Amostrando frames (trocas de cena, picos de áudio, silêncios)');
  const scenes = await cached<number[]>('scenes.json', () =>
    detectSceneChanges(job.inputPath, { signal, duration: info.duration, onProgress: (p) => progress('frames', p * 0.7) }),
  );
  const frames = await cached<ExtractedFrame[]>('frames.json', async () => {
    const times = pickFrameTimes(info.duration, { scenes, peaks: findEnergyPeaks(energy), silenceEnds: silences.map((x) => x.end) }, 24);
    return extractFrames(job.inputPath, times, usableDir(path.join(tempDir, 'frames')), { signal, onProgress: (p) => progress('frames', 0.7 + p * 0.3) });
  });
  log('info', `${scenes.length} trocas de cena detectadas; ${frames.length} frames extraídos`);

  // ---------------- 4. Seleção (IA) ----------------
  begin('select', 'Selecionando os melhores cortes');
  let llm: LLMProvider | null = null;
  try {
    llm = createLLM(app);
  } catch (e) {
    log('warn', `${(e as Error).message} — usando seleção heurística local`);
  }
  result.provider = llm ? `${llm.name}/${llm.model}` : 'heuristic';
  const sentences = buildSentences(transcript);
  const selected = await cached<SelectedClip[]>('selected.json', async () => {
    let candidates: ClipCandidate[] = [];
    if (llm) {
      try {
        log('info', `Enviando transcrição${app.sendFramesToAI && llm.supportsImages ? ' + frames' : ''} para ${llm.name}/${llm.model}`);
        candidates = await aiSelectCandidates({ llm, transcript, settings: s, app, videoDuration: info.duration, frames, signal, log: (l, m) => log(l, m) });
        candidates = candidates.map((c) => ({ ...c, ...snapToSentences(c.start, c.end, sentences, info.duration) }));
        log('info', `IA propôs ${candidates.length} candidatos`);
      } catch (e) {
        if (signal.aborted) throw e;
        log('warn', `Seleção por IA falhou (${(e as Error).message}); usando heurística local`);
        candidates = [];
      }
    }
    if (!candidates.length) {
      candidates = heuristicCandidates(transcript, { targetDuration: s.targetDuration, videoDuration: info.duration, energy, sceneChanges: scenes });
      log('info', `Heurística gerou ${candidates.length} candidatos`);
    }
    fs.writeFileSync(path.join(tempDir, 'candidates.json'), JSON.stringify(candidates));
    const picked = selectClips(candidates, {
      maxClips: s.maxClips,
      videoDuration: info.duration,
      targetDuration: s.targetDuration,
      minScore: llm ? 60 : 55,
    });
    return picked.map((c, index) => ({ ...c, index }));
  });
  if (!selected.length) throw new Error('Nenhum corte selecionado.');
  replaceClips(job.id, selected.map((c) => ({ index: c.index, title: c.title, start: c.start, end: c.end, score: c.score, reason: c.reason })));
  for (const c of selected) log('info', `Corte ${c.index + 1}: ${c.start.toFixed(1)}s–${c.end.toFixed(1)}s (nota ${Math.round(c.score)}) "${c.title}"`);
  progress('select', 1, true);

  // ---------------- 5. Plano de edição ----------------
  begin('plan', `Gerando plano de edição (intensidade ${s.intensity})`);
  const library = scanLibrary();
  const clipWords = new Map<number, TranscriptWord[]>(selected.map((c) => [c.index, wordsInRange(transcript, c.start, c.end)]));
  const plan = await cached<ResolvedEdit[]>('plan.json', async () => {
    let aiEdits = new Map<number, ClipEdit>();
    if (llm) {
      try {
        aiEdits = await aiPlanEdits({
          llm,
          clips: selected.map((c) => ({ index: c.index, duration: c.end - c.start, title: c.title, words: clipWords.get(c.index)! })),
          settings: s,
          library,
          signal,
          log: (l, m) => log(l, m),
        });
      } catch (e) {
        if (signal.aborted) throw e;
        log('warn', `Plano por IA falhou (${(e as Error).message}); usando plano heurístico`);
      }
    }
    return selected.map((c) => {
      const duration = c.end - c.start;
      const seed = `${job.id}:${c.index}`;
      const ai = aiEdits.get(c.index);
      const edit = ai
        ? normalizeEdit(ai, duration, s)
        : heuristicEdit({ clipIndex: c.index, words: clipWords.get(c.index)!, duration, settings: s, library, seed });
      const resolved = resolveEdit(edit, library, seed);
      for (const w of resolved.warnings) log('warn', `Corte ${c.index + 1}: ${w}`);
      return resolved;
    });
  });
  for (const p of plan) log('info', `Corte ${p.clipIndex + 1}: ${p.zooms.length} zooms, ${p.overlays.length} memes, ${p.sfx.length} efeitos sonoros`);

  // ---------------- 6. Legendas antigas / tradução ----------------
  begin('subtitles', 'Tratando legendas antigas e tradução');
  let subRegion: { y: number; h: number } | null = null;
  if (s.removeOldSubtitles) {
    const det = await cached('subregion.json', () => detectSubtitleRegion(frames.map((f) => f.path), signal));
    if (det.found && det.y !== undefined && det.h !== undefined) {
      subRegion = { y: det.y, h: det.h };
      log('info', `Legenda antiga detectada em y=${(det.y * 100).toFixed(0)}% (altura ${(det.h * 100).toFixed(0)}%), confiança ${det.confidence}`);
    } else {
      subRegion = { y: 0.8, h: 0.13 };
      log('warn', 'Legenda antiga não detectada com confiança; desfocando a faixa inferior padrão');
    }
  }
  let translated: Map<number, string> | null = null;
  const wantsTranslation = !!s.translateTo && s.translateTo !== transcript.language;
  if (wantsTranslation) {
    if (!llm) {
      log('warn', 'Tradução requer um provedor de IA (Gemini, Anthropic ou Ollama). Legendas ficarão no idioma original.');
    } else {
      try {
        const relevant = transcript.segments.filter((seg) => selected.some((c) => seg.end > c.start && seg.start < c.end));
        const obj = await cached<Record<string, string>>(`translation_${s.translateTo}.json`, async () => {
          const m = await translateSegments({ llm: llm!, segments: relevant.map((x) => ({ id: x.id, text: x.text })), targetLang: s.translateTo, sourceLang: transcript.language, signal, log: (l, m2) => log(l, m2) });
          return Object.fromEntries(m);
        });
        translated = new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
        log('info', `${translated.size} segmentos traduzidos para ${s.translateTo}`);
      } catch (e) {
        if (signal.aborted) throw e;
        log('warn', `Tradução falhou: ${(e as Error).message}`);
      }
    }
  }
  progress('subtitles', 1, true);

  // ---------------- 7. Renderização ----------------
  begin('render', `Renderizando ${selected.length} corte(s) — formato ${s.format}, encoder ${app.hwAccel === 'nvenc' ? 'NVENC' : 'x264'}`);
  const canvas = canvasSize(s.format, info);
  const assetAudio = new Map<string, boolean>();
  let rendered = 0;
  let failed = 0;
  const clipsMeta: unknown[] = [];

  for (const c of selected) {
    signal.throwIfAborted();
    const n = String(c.index + 1).padStart(3, '0');
    const base = path.join(clipsDir, `clip_${n}`);
    const edit = plan.find((p) => p.clipIndex === c.index)!;
    const duration = c.end - c.start;
    const tick = (p: number) => progress('render', (c.index + p) / selected.length);
    updateClip(job.id, c.index, { status: 'rendering', error: null });
    try {
      const emphasis = new Set(edit.emphasisWords.map((w) => w.toLowerCase()));
      const words = clipWords.get(c.index)!.map((w) => ({ ...w, emphasis: emphasis.has(w.word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()) }));
      const translatedWords = translated ? translatedWordsFor(transcript, translated, c.start, c.end) : null;

      for (const o of edit.overlays) {
        if (!assetAudio.has(o.file)) assetAudio.set(o.file, (await probeAsset(o.file)).hasAudio);
      }
      const ass = s.burnSubtitles ? buildAss(translatedWords ?? words, { width: canvas.width, height: canvas.height, intensity: s.intensity }) : undefined;

      await renderClip({
        input: job.inputPath,
        start: c.start,
        end: c.end,
        source: info,
        format: s.format,
        zooms: edit.zooms,
        overlays: edit.overlays.map((o) => ({ file: o.file, at: o.at, duration: o.duration, position: o.position, scale: o.scale, hasAudio: assetAudio.get(o.file), volume: 0.9 })),
        sfx: edit.sfx.map((x) => ({ file: x.file, at: x.at, volume: x.volume })),
        assContent: ass,
        removeSubtitleRegion: subRegion,
        output: `${base}.mp4`,
        workDir: usableDir(path.join(tempDir, `render_${n}`)),
        hwAccel: app.hwAccel,
        threads: app.threads,
        signal,
        onProgress: (p) => tick(p * 0.95),
      });
      await extractThumbnail(`${base}.mp4`, `${base}.jpg`, Math.min(1.5, duration / 2)).catch(() => undefined);

      let srtPath: string | null = null;
      const srtFiles: Record<string, string> = {};
      if (s.exportSrt) {
        srtPath = `${base}.srt`;
        fs.writeFileSync(srtPath, buildSrt(words), 'utf8');
        srtFiles[transcript.language] = path.basename(srtPath);
        if (translatedWords) {
          const tp = `${base}.${s.translateTo}.srt`;
          fs.writeFileSync(tp, buildSrt(translatedWords), 'utf8');
          srtFiles[s.translateTo] = path.basename(tp);
        }
      }
      const meta = {
        index: c.index + 1,
        title: c.title,
        score: Math.round(c.score),
        reason: c.reason,
        hook: c.hook ?? null,
        source: { file: path.basename(job.inputPath), start: c.start, end: c.end },
        duration: Number(duration.toFixed(3)),
        format: s.format,
        resolution: `${canvas.width}x${canvas.height}`,
        intensity: s.intensity,
        language: transcript.language,
        translatedTo: translatedWords ? s.translateTo : null,
        subtitlesBurned: s.burnSubtitles,
        provider: result.provider,
        edit: {
          zooms: edit.zooms,
          overlays: edit.overlays.map((o) => ({ ...o, file: o.fileName })),
          sfx: edit.sfx.map((x) => ({ ...x, file: x.fileName })),
          emphasisWords: edit.emphasisWords,
        },
        files: { video: path.basename(`${base}.mp4`), thumbnail: path.basename(`${base}.jpg`), srt: srtFiles },
        transcript: words.map((w) => w.word).join(' '),
        renderedAt: new Date().toISOString(),
      };
      fs.writeFileSync(`${base}.json`, JSON.stringify(meta, null, 2), 'utf8');
      clipsMeta.push(meta);
      updateClip(job.id, c.index, { status: 'completed', outputPath: `${base}.mp4`, srtPath, metadataPath: `${base}.json` });
      rendered++;
      log('info', `✔ clip_${n}.mp4 renderizado (${duration.toFixed(1)}s)`);
    } catch (e) {
      if (signal.aborted) throw e;
      // Falha isolada: registra e segue para o próximo corte
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      updateClip(job.id, c.index, { status: 'failed', error: msg.slice(0, 2000) });
      log('error', `✘ clip_${n} falhou: ${msg}`);
    }
    tick(1);
  }

  // ---------------- 8. Exportação ----------------
  begin('export', 'Organizando arquivos de saída');
  const allWords = flattenWords(transcript.segments);
  fs.writeFileSync(path.join(outputDir, 'transcript.json'), JSON.stringify(transcript), 'utf8');
  fs.writeFileSync(path.join(outputDir, 'transcript.srt'), buildSrt(allWords), 'utf8');
  fs.writeFileSync(
    path.join(outputDir, 'metadata.json'),
    JSON.stringify(
      {
        jobId: job.id,
        source: { file: job.inputPath, ...info },
        settings: s,
        provider: result.provider,
        whisper: { model: transcript.model, device: transcript.device, language: transcript.language },
        clips: clipsMeta,
        rendered,
        failed,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
  setJobResult(job.id, { ...result, language: transcript.language, clipsRendered: rendered, clipsFailed: failed });

  if (failed === 0) {
    // A limpeza nunca derruba o job: no Windows um handle recém-fechado pode atrasar a remoção.
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      log('info', 'Pasta temporária limpa');
    } catch (e) {
      log('warn', `Não foi possível limpar ${tempDir} agora (${(e as Error).message}); será limpa na próxima inicialização do worker`);
    }
  } else {
    log('warn', `Arquivos temporários mantidos em ${tempDir} para permitir "Tentar novamente" sem refazer a transcrição`);
  }
  progress('export', 1, true);
  return { rendered, failed };
}

/** Palavras sintéticas (tempo proporcional) a partir dos segmentos traduzidos, relativas ao corte. */
function translatedWordsFor(t: Transcript, tr: Map<number, string>, start: number, end: number): TranscriptWord[] {
  const segs = t.segments
    .filter((seg) => seg.end > start && seg.start < end && tr.has(seg.id))
    .map((seg) => ({ start: Math.max(0, seg.start - start), end: Math.min(end - start, seg.end - start), text: tr.get(seg.id)! }));
  return synthesizeWords(segs);
}
