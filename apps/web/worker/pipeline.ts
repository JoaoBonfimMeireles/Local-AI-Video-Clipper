import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  aiAnalyzeVideo,
  aiPlanEdits,
  aiSelectCandidates,
  aiSelectFromKnowledge,
  createLLM,
  detectFaces,
  detectSubtitleRegion,
  estimateCostUsd,
  type DetectedFace,
  transcribe,
  translateSegments,
  type LLMProvider,
} from '@clipper/ai-providers';
import {
  buildSentences,
  clipDuration,
  heuristicCandidates,
  segmentsOf,
  selectClips,
  snapToSentences,
  wordsForSegments,
  type ClipCandidate,
  type ClipSegment,
} from '@clipper/clip-selection';
import { heuristicEdit, heuristicShots, normalizeEdit, refineShots, resolveEdit, type ClipEdit, type ResolvedEdit, type VideoKnowledge } from '@clipper/editing-planner';
import { creditLine, flattenWords, formatTimestamp, slugify, type AppSettings, type Job, type JobResult, type PipelineStep, type ProbeInfo, type Transcript, type TranscriptWord } from '@clipper/shared';
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
  extractClipFramesFps,
  extractFrames,
  extractThumbnail,
  findEnergyPeaks,
  pickFrameTimes,
  prepareClipSource,
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
  segments: ClipSegment[];
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
  // CLIPPER_FORCE_PROVIDER permite testes automatizados sem consumir cota de IA
  const forced = process.env.CLIPPER_FORCE_PROVIDER as AppSettings['aiProvider'] | undefined;
  const app = { ...getAppSettings(), ...(forced ? { aiProvider: forced } : {}) };
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
  // Cache global: o mesmo vídeo (mesmo arquivo, modelo e idioma) não é transcrito duas vezes,
  // mesmo em jobs diferentes — útil para testar parâmetros de edição no mesmo vídeo.
  const globalCache = transcriptCachePath(job.inputPath, app.whisperModel, s.sourceLanguage);
  if (!fs.existsSync(path.join(tempDir, 'transcript.json')) && fs.existsSync(globalCache)) {
    fs.copyFileSync(globalCache, path.join(tempDir, 'transcript.json'));
    log('info', 'Transcrição reaproveitada do cache (este vídeo já foi transcrito antes com o mesmo modelo)');
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
  if (!fs.existsSync(globalCache)) {
    fs.mkdirSync(path.dirname(globalCache), { recursive: true });
    fs.writeFileSync(globalCache, JSON.stringify(transcript));
  }
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

  // ---------------- 4. Conhecimento do vídeo + seleção (IA) ----------------
  begin('select', 'Analisando o vídeo e selecionando os melhores cortes');
  // Um provedor por papel: no plano combinado do Gemini, o Pro escolhe os cortes e o Flash faz o resto.
  let llm: LLMProvider | null = null;
  let editLlm: LLMProvider | null = null;
  let translateLlm: LLMProvider | null = null;
  try {
    llm = createLLM(app, 'select');
    editLlm = createLLM(app, 'edit');
    translateLlm = createLLM(app, 'translate');
  } catch (e) {
    log('warn', `${(e as Error).message} — usando seleção heurística local`);
  }
  const usedLlms = [llm, editLlm, translateLlm].filter((x): x is LLMProvider => !!x);
  for (const l of usedLlms) l.onNotice = (m) => log('warn', m);
  result.provider = llm
    ? llm.model === editLlm?.model
      ? `${llm.name}/${llm.model}${llm.free ? ' (gratuito)' : ''}`
      : `${llm.name}: ${llm.model} (cortes) + ${editLlm?.model} (edição/textos)`
    : 'heuristic';
  if (llm) log('info', `IA: ${result.provider}${app.editingPrompt.trim() ? ' — usando suas diretrizes editoriais' : ''}`);

  // Conhecimento do vídeo (resumo, pessoas, momentos): calculado uma vez por vídeo e reaproveitado
  // em qualquer job futuro com o mesmo arquivo — economiza transcrição + frames nas próximas edições.
  const cacheBase = videoCacheBase(job.inputPath, app.whisperModel, s.sourceLanguage);
  let knowledge: VideoKnowledge | null = null;
  if (llm) {
    const kFile = `${cacheBase}.knowledge.json`;
    if (fs.existsSync(kFile)) {
      knowledge = JSON.parse(fs.readFileSync(kFile, 'utf8')) as VideoKnowledge;
      log('info', `Conhecimento do vídeo reaproveitado do cache (${knowledge.moments.length} momentos) — sem reenviar transcrição e frames`);
    } else {
      try {
        log('info', `Analisando o vídeo com ${llm.model} (transcrição${app.sendFramesToAI ? ' + frames' : ''}); o resultado fica em cache`);
        knowledge = await aiAnalyzeVideo({ llm, transcript, videoDuration: info.duration, frames, sendImages: app.sendFramesToAI, signal, log: (l, m) => log(l, m) });
        fs.mkdirSync(path.dirname(kFile), { recursive: true });
        fs.writeFileSync(kFile, JSON.stringify(knowledge));
        log('info', `Análise concluída: ${knowledge.speakers.length} pessoa(s), ${knowledge.moments.length} momentos`);
      } catch (e) {
        if (signal.aborted) throw e;
        log('warn', `Análise do vídeo falhou (${(e as Error).message}); a seleção usará a transcrição completa`);
      }
    }
    if (knowledge) fs.writeFileSync(path.join(outputDir, 'video_knowledge.json'), JSON.stringify(knowledge, null, 2), 'utf8');
  }

  const sentences = buildSentences(transcript);
  /** Alinha cada trecho a frases inteiras e limita a duração total (somando os trechos). */
  const tidy = (c: ClipCandidate): ClipCandidate => {
    let segs = segmentsOf(c).map((sg) => snapToSentences(sg.start, sg.end, sentences, info.duration));
    const maxDur = s.targetDuration * 1.6;
    const total = () => segs.reduce((a, sg) => a + (sg.end - sg.start), 0);
    if (total() > maxDur) {
      const before = total();
      while (segs.length > 1 && total() - (segs[segs.length - 1].end - segs[segs.length - 1].start) >= s.targetDuration * 0.6) segs = segs.slice(0, -1);
      if (total() > maxDur) {
        const last = segs[segs.length - 1];
        const budget = s.targetDuration * 1.5 - (total() - (last.end - last.start));
        segs[segs.length - 1] = snapToSentences(last.start, last.start + Math.max(5, budget), sentences, info.duration);
      }
      log('info', `Corte "${c.title}" tinha ${before.toFixed(0)}s; ajustado para ${total().toFixed(0)}s`);
    }
    return { ...c, segments: segs, start: Math.min(...segs.map((x) => x.start)), end: Math.max(...segs.map((x) => x.end)) };
  };

  const selected = await cached<SelectedClip[]>('selected.json', async () => {
    let candidates: ClipCandidate[] = [];
    if (llm) {
      try {
        if (knowledge) {
          candidates = await aiSelectFromKnowledge({ llm, knowledge, settings: s, app, videoDuration: info.duration, signal, log: (l, m) => log(l, m) });
        } else {
          log('info', `Enviando transcrição${app.sendFramesToAI && llm.supportsImages ? ' + frames' : ''} para ${llm.name}/${llm.model}`);
          candidates = await aiSelectCandidates({ llm, transcript, settings: s, app, videoDuration: info.duration, frames, signal, log: (l, m) => log(l, m) });
        }
        candidates = candidates.map(tidy);
        log('info', `IA propôs ${candidates.length} candidatos (${candidates.filter((c) => segmentsOf(c).length > 1).length} juntando trechos)`);
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
    const picked = selectClips(candidates, { maxClips: s.maxClips, videoDuration: info.duration, targetDuration: s.targetDuration, minScore: llm ? 60 : 55 });
    return picked.map((c, index) => ({ ...c, segments: segmentsOf(c), index }));
  });
  if (!selected.length) throw new Error('Nenhum corte selecionado.');
  replaceClips(job.id, selected.map((c) => ({ index: c.index, title: c.title, start: c.start, end: c.end, score: c.score, reason: c.reason })));
  for (const c of selected) {
    const parts = c.segments.map((sg) => `${sg.start.toFixed(1)}–${sg.end.toFixed(1)}s`).join(' + ');
    log('info', `Corte ${c.index + 1}: ${parts} = ${clipDuration(c).toFixed(0)}s (nota ${Math.round(c.score)}) "${c.title}"`);
  }
  progress('select', 1, true);

  // ---------------- 5. Plano de edição ----------------
  begin('plan', `Gerando plano de edição e enquadramento (intensidade ${s.intensity})`);
  const library = scanLibrary();
  const clipWords = new Map<number, TranscriptWord[]>(selected.map((c) => [c.index, wordsForSegments(transcript, c.segments)]));
  const plan = await cached<ResolvedEdit[]>('plan.json', async () => {
    // Frames a cada 1s + rostos (YuNet local) + cortes de câmera do original, na linha do tempo de cada corte
    const visual = new Map<number, { frames: { time: number; path: string; faces: DetectedFace[] }[]; cuts: number[] }>();
    for (const c of selected) {
      const dense = await extractClipFramesFps(job.inputPath, c.segments, usableDir(path.join(tempDir, `clipframes_${c.index}`)), { fps: 1, signal });
      const faces = await detectFaces(dense.map((f) => f.path), signal);
      const cuts: number[] = [];
      let offset = 0;
      c.segments.forEach((sg, k) => {
        if (k > 0) cuts.push(offset);
        for (const t of scenes) if (t > sg.start + 0.3 && t < sg.end - 0.3) cuts.push(offset + (t - sg.start));
        offset += sg.end - sg.start;
      });
      visual.set(c.index, { frames: dense.map((f, i) => ({ ...f, faces: faces[i] ?? [] })), cuts: cuts.map((t) => Number(t.toFixed(2))) });
    }
    const facesFound = [...visual.values()].reduce((a, v) => a + v.frames.filter((f) => f.faces.length).length, 0);
    log('info', `Análise visual local: ${facesFound} frames com rostos detectados, ${[...visual.values()].reduce((a, v) => a + v.cuts.length, 0)} cortes de câmera nos trechos`);
    let aiEdits = new Map<number, ClipEdit>();
    if (editLlm) {
      try {
        // Imagens para a IA: o 1º frame após cada corte de câmera + amostras regulares, com os rostos descritos
        const clipFrames = new Map<number, { time: number; path: string; note?: string }[]>();
        if (app.sendFramesToAI && editLlm.supportsImages) {
          for (const c of selected) {
            const v = visual.get(c.index)!;
            const pick = new Set<number>();
            for (const cut of [0, ...v.cuts]) {
              const i = v.frames.findIndex((f) => f.time >= cut + 0.3);
              if (i >= 0) pick.add(i);
            }
            const step = Math.max(1, Math.floor(v.frames.length / 8));
            for (let i = 0; i < v.frames.length; i += step) pick.add(i);
            const chosen = [...pick].sort((a, b) => a - b).slice(0, 16);
            clipFrames.set(
              c.index,
              chosen.map((i) => ({ ...v.frames[i], note: describeFaces(v.frames[i].faces) })),
            );
          }
        }
        log('info', `Plano de edição, enquadramento, títulos e hashtags com ${editLlm.model}`);
        aiEdits = await aiPlanEdits({
          llm: editLlm,
          clips: selected.map((c) => ({ index: c.index, duration: clipDuration(c), title: c.title, words: clipWords.get(c.index)!, frames: clipFrames.get(c.index), cuts: visual.get(c.index)!.cuts })),
          settings: s,
          library,
          language: app.postLanguage || transcript.language,
          guidelines: app.editingPrompt,
          knowledge,
          sendImages: app.sendFramesToAI,
          signal,
          log: (l, m) => log(l, m),
        });
      } catch (e) {
        if (signal.aborted) throw e;
        log('warn', `Plano por IA falhou (${(e as Error).message}); usando plano heurístico`);
      }
    }
    return selected.map((c) => {
      const duration = clipDuration(c);
      const seed = `${job.id}:${c.index}`;
      const ai = aiEdits.get(c.index);
      const edit = ai ? normalizeEdit(ai, duration, s) : heuristicEdit({ clipIndex: c.index, words: clipWords.get(c.index)!, duration, settings: s, library, seed });
      // A IA decide quem/o que enquadrar; a detecção local de rostos corrige onde está, cena a cena
      const v = visual.get(c.index)!;
      const ctx = { duration, cuts: v.cuts, frames: v.frames };
      edit.shots = edit.shots.length
        ? refineShots(edit.shots, ctx)
        : s.format === 'original'
          ? []
          : heuristicShots({ ...ctx, preferWide: s.format !== 'vertical_crop' || s.intensity === 'low' });
      const resolved = resolveEdit(edit, library, seed);
      for (const w of resolved.warnings) log('warn', `Corte ${c.index + 1}: ${w}`);
      return resolved;
    });
  });
  for (const p of plan) {
    const shotKinds = p.shots.length ? ` (${p.shots.filter((x) => x.type === 'wide').length} abertos, ${p.shots.filter((x) => x.type === 'focus' && x.scale >= 1.3).length} aproximações)` : '';
    log('info', `Corte ${p.clipIndex + 1}: ${p.shots.length} enquadramentos${shotKinds}, ${p.zooms.length} zooms, ${p.overlays.length} memes, ${p.sfx.length} efeitos sonoros`);
    // Créditos do vídeo original (Creative Commons) sempre ao fim da descrição
    const credit = creditLine(s);
    if (credit && !p.description?.includes(credit)) p.description = [p.description, credit].filter(Boolean).join('\n\n');
    if (p.title || p.description || p.hashtags.length) {
      const c = selected.find((x) => x.index === p.clipIndex)!;
      if (p.title) c.title = p.title;
      updateClip(job.id, p.clipIndex, { title: c.title, description: p.description ?? null, hashtags: p.hashtags });
    }
  }

  // ---------------- 6. Legendas antigas / tradução / texto em português ----------------
  begin('subtitles', 'Detectando legenda antiga, traduzindo e gerando o texto em português');
  let subRegion: { y: number; h: number } | null = null;
  if (s.removeOldSubtitles) {
    const det = await cached('subregion.json', () => detectSubtitleRegion(frames.map((f) => f.path), signal));
    if (det.found && det.y !== undefined && det.h !== undefined) {
      subRegion = { y: det.y, h: det.h };
      log('info', `Legenda antiga detectada em y=${(det.y * 100).toFixed(0)}% (altura ${(det.h * 100).toFixed(0)}%)`);
    } else {
      log('info', 'Nenhuma legenda antiga detectada no vídeo original');
    }
  }
  // Legenda embaixo ou em cima: enquadra sem ela (100% imagem real). No meio da tela: apaga e preenche.
  let cleanArea: { y0: number; y1: number } | null = null;
  let inpaintRegion: { y: number; h: number } | null = null;
  if (subRegion) {
    const area = subRegion.y >= 0.5 ? { y0: 0, y1: subRegion.y } : subRegion.y + subRegion.h <= 0.5 ? { y0: subRegion.y + subRegion.h, y1: 1 } : null;
    if (app.subtitleRemoval === 'crop' && area && area.y1 - area.y0 >= 0.6) {
      cleanArea = area;
      log('info', `Legenda antiga ficará fora do quadro (usando ${Math.round((area.y1 - area.y0) * 100)}% da altura do vídeo)`);
    } else {
      inpaintRegion = subRegion;
      log('info', 'Legenda antiga será apagada e preenchida com o fundo do vídeo');
    }
  }
  let translated: Map<number, string> | null = null;
  const wantsTranslation = !!s.translateTo && s.translateTo !== transcript.language;
  if (wantsTranslation) {
    if (!translateLlm) {
      log('warn', 'Tradução requer um provedor de IA (Gemini, Anthropic ou Ollama). Legendas ficarão no idioma original.');
    } else {
      try {
        const relevant = transcript.segments.filter((seg) => selected.some((c) => c.segments.some((sg) => seg.end > sg.start && seg.start < sg.end)));
        const obj = await cached<Record<string, string>>(`translation_${s.translateTo}.json`, async () => {
          const m = await translateSegments({ llm: translateLlm!, segments: relevant.map((x) => ({ id: x.id, text: x.text })), targetLang: s.translateTo, sourceLang: transcript.language, guidelines: app.editingPrompt, signal, log: (l, m2) => log(l, m2) });
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
  // Texto em português do que é falado (só texto, sem vídeo extra), também em cache por vídeo
  if (app.ptTranscript) {
    try {
      const ptFile = path.join(outputDir, 'transcricao_pt.txt');
      let ptBySeg: Map<number, string> | null = null;
      if (transcript.language === 'pt') {
        ptBySeg = new Map(transcript.segments.map((x) => [x.id, x.text]));
      } else if (translateLlm) {
        const cacheFile = `${cacheBase}.pt.json`;
        if (fs.existsSync(cacheFile)) {
          ptBySeg = new Map(Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Record<string, string>).map(([k, v]) => [Number(k), v]));
          log('info', 'Texto em português reaproveitado do cache');
        } else {
          ptBySeg = await translateSegments({ llm: translateLlm, segments: transcript.segments.map((x) => ({ id: x.id, text: x.text })), targetLang: 'pt', sourceLang: transcript.language, signal, log: (l, m) => log(l, m) });
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
          fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(ptBySeg)));
          log('info', `Texto em português gerado (${ptBySeg.size} trechos)`);
        }
      } else {
        log('warn', 'Texto em português requer um provedor de IA; pulando');
      }
      if (ptBySeg) {
        const lines = transcript.segments.map((x) => `[${formatTimestamp(x.start)}] ${ptBySeg!.get(x.id) || x.text}`);
        const header = knowledge ? `RESUMO: ${knowledge.summary}\n\n` : '';
        fs.writeFileSync(ptFile, `${header}${lines.join('\n')}\n`, 'utf8');
      }
    } catch (e) {
      if (signal.aborted) throw e;
      log('warn', `Não foi possível gerar o texto em português: ${(e as Error).message}`);
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
    const duration = clipDuration(c);
    const tick = (p: number) => progress('render', (c.index + p) / selected.length);
    updateClip(job.id, c.index, { status: 'rendering', error: null });
    try {
      const emphasis = new Set(edit.emphasisWords.map((w) => w.toLowerCase()));
      const words = clipWords.get(c.index)!.map((w) => ({ ...w, emphasis: emphasis.has(w.word.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()) }));
      const translatedWords = translated ? translatedWordsFor(transcript, translated, c.segments) : null;

      for (const o of edit.overlays) {
        if (!assetAudio.has(o.file)) assetAudio.set(o.file, (await probeAsset(o.file)).hasAudio);
      }
      const ass = s.burnSubtitles ? buildAss(translatedWords ?? words, { width: canvas.width, height: canvas.height, intensity: s.intensity }) : undefined;
      const workDir = usableDir(path.join(tempDir, `render_${n}`));

      // Trechos emendados e/ou legenda antiga apagada: gera antes um vídeo-fonte limpo do corte
      let input = job.inputPath;
      let start = c.start;
      if (c.segments.length > 1 || inpaintRegion) {
        log('info', `Corte ${c.index + 1}: preparando fonte${c.segments.length > 1 ? ` (${c.segments.length} trechos)` : ''}${inpaintRegion ? ' e apagando a legenda antiga' : ''}`);
        input = path.join(workDir, 'source.mp4');
        start = 0;
        await prepareClipSource({ input: job.inputPath, segments: c.segments, source: info, subtitleRegion: inpaintRegion, output: input, workDir, signal, onProgress: (p) => tick(p * 0.5) });
      }

      await renderClip({
        input,
        start,
        end: start + duration,
        source: input === job.inputPath ? info : { ...info, hasAudio: true },
        format: s.format,
        shots: edit.shots,
        cleanArea,
        zooms: edit.zooms,
        overlays: edit.overlays.map((o) => ({ file: o.file, at: o.at, duration: o.duration, position: o.position, scale: o.scale, hasAudio: assetAudio.get(o.file), volume: 0.9 })),
        sfx: edit.sfx.map((x) => ({ file: x.file, at: x.at, volume: x.volume })),
        assContent: ass,
        output: `${base}.mp4`,
        workDir,
        hwAccel: app.hwAccel,
        threads: app.threads,
        signal,
        onProgress: (p) => tick(input === job.inputPath ? p * 0.95 : 0.5 + p * 0.45),
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
        description: edit.description ?? null,
        hashtags: edit.hashtags,
        source: { file: path.basename(job.inputPath), start: c.start, end: c.end, segments: c.segments },
        duration: Number(duration.toFixed(3)),
        format: s.format,
        resolution: `${canvas.width}x${canvas.height}`,
        intensity: s.intensity,
        language: transcript.language,
        translatedTo: translatedWords ? s.translateTo : null,
        subtitlesBurned: s.burnSubtitles,
        oldSubtitlesRemoved: !!subRegion,
        provider: result.provider,
        edit: {
          shots: edit.shots,
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
  if (usedLlms.length) {
    // Custo estimado pelos preços públicos (o plano gratuito não é cobrado)
    const free = usedLlms.every((l) => l.free);
    const aiUsage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, free };
    for (const l of new Set(usedLlms)) {
      aiUsage.calls += l.usage.calls;
      aiUsage.inputTokens += l.usage.inputTokens;
      aiUsage.outputTokens += l.usage.outputTokens;
      if (!l.free) aiUsage.costUsd += estimateCostUsd(l.model, l.usage);
    }
    result.aiUsage = aiUsage;
    if (aiUsage.calls) {
      log('info', `Uso de IA: ${aiUsage.calls} chamada(s), ${aiUsage.inputTokens.toLocaleString('pt-BR')} tokens de entrada, ${aiUsage.outputTokens.toLocaleString('pt-BR')} de saída — ${free ? 'plano gratuito (sem custo)' : `custo estimado US$ ${aiUsage.costUsd.toFixed(4)}`}`);
    }
  }
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

/**
 * Base dos arquivos de cache de um vídeo (transcrição, conhecimento da IA, texto em português).
 * Identifica o arquivo por nome, tamanho e data de modificação, mais modelo/idioma do Whisper.
 */
export function videoCacheBase(input: string, model: string, language: string): string {
  const st = fs.statSync(input);
  const key = createHash('sha1').update([path.basename(input), st.size, Math.floor(st.mtimeMs), model, language].join('|')).digest('hex').slice(0, 20);
  return path.join(dataPaths.root, 'cache', 'transcripts', key);
}

export function transcriptCachePath(input: string, model: string, language: string): string {
  return `${videoCacheBase(input, model, language)}.json`;
}

/** "2 rostos: x=0.31, x=0.64 (close)" — dica textual para a IA junto de cada imagem. */
function describeFaces(faces: DetectedFace[]): string {
  if (!faces.length) return 'nenhum rosto detectado';
  const parts = faces.slice(0, 4).map((f) => `x=${f.x.toFixed(2)}${f.w > 0.2 ? ' (close)' : ''}`);
  return `${faces.length} rosto(s): ${parts.join(', ')}`;
}

/** Palavras sintéticas (tempo proporcional) a partir dos segmentos traduzidos, relativas ao corte. */
function translatedWordsFor(t: Transcript, tr: Map<number, string>, clipSegments: ClipSegment[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let offset = 0;
  for (const { start, end } of clipSegments) {
    const segs = t.segments
      .filter((seg) => seg.end > start && seg.start < end && tr.has(seg.id))
      .map((seg) => ({ start: Math.max(0, seg.start - start) + offset, end: Math.min(end - start, seg.end - start) + offset, text: tr.get(seg.id)! }));
    out.push(...synthesizeWords(segs));
    offset += end - start;
  }
  return out;
}
