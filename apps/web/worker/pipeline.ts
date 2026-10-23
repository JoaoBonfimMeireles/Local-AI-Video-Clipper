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
import { buildCatalog, detectFacecam, ILLUSTRATION_CATEGORY, findAssetsByKeywords, heuristicEdit, shortlistLibrary, type ClipLayout, heuristicShots, normalizeEdit, refineShots, resolveEdit, type AssetMeta, type ClipEdit, type ResolvedEdit, type VideoKnowledge } from '@clipper/editing-planner';
import { creditLine, flattenWords, formatTimestamp, slugify, TWITCH_CATEGORIES, type AppSettings, type Job, type JobResult, type PipelineStep, type ProbeInfo, type Transcript, type TranscriptWord } from '@clipper/shared';
import {
  addJobLog,
  dataPaths,
  getAppSettings,
  getJob,
  replaceClips,
  resolveLibraryFile,
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
  analyzeAssets,
  detectContentRegion,
  extractAudio,
  planSoundPauses,
  shiftForPauses,
  type AssetInfo,
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
import { combineGuidelines, getStyleGuide } from './references';
import { getIllustration } from './illustrations';

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

  // Modo Twitch: se há facecam fixa num canto, o vertical vira facecam (em cima) + jogo (embaixo)
  let splitLayout: { cam: { x0: number; y0: number; x1: number; y1: number } } | null = null;
  const verticalOut = s.format === 'vertical_blur' || s.format === 'vertical_crop';
  if (s.mode === 'twitch' && verticalOut && s.twitchLayout !== 'full') {
    const camBox = await cached('facecam.json', async () => detectFacecam(await detectFaces(frames.map((f) => f.path), signal)));
    if (camBox) {
      splitLayout = { cam: camBox };
      log('info', `Facecam detectada (x ${Math.round(camBox.x0 * 100)}–${Math.round(camBox.x1 * 100)}%, y ${Math.round(camBox.y0 * 100)}–${Math.round(camBox.y1 * 100)}%): layout facecam + jogo`);
    } else {
      log(s.twitchLayout === 'split' ? 'warn' : 'info', 'Nenhuma facecam fixa detectada; usando enquadramento por pessoas');
    }
  }

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
  // Guia de estilo aprendido dos clipes de referência (data/references): analisados uma vez, em cache
  let styleGuide: string | null = null;
  if (llm && app.useReferences) {
    try {
      styleGuide = await getStyleGuide({ app, llm: editLlm ?? llm, log: (l, m) => log(l, m), signal, analyzeMissing: true });
    } catch (e) {
      if (signal.aborted) throw e;
      log('warn', `Guia de estilo indisponível: ${(e as Error).message}`);
    }
  }
  const guidelines = combineGuidelines(app.editingPrompt, styleGuide);
  const appGuided = { ...app, editingPrompt: guidelines };
  if (llm) log('info', `IA: ${result.provider}${app.editingPrompt.trim() ? ' — usando suas diretrizes editoriais' : ''}${styleGuide ? ' — seguindo o guia de estilo das referências' : ''}`);

  // Conhecimento do vídeo (resumo, pessoas, momentos): calculado uma vez por vídeo e reaproveitado
  // em qualquer job futuro com o mesmo arquivo — economiza transcrição + frames nas próximas edições.
  const cacheBase = videoCacheBase(job.inputPath, app.whisperModel, s.sourceLanguage);
  let knowledge: VideoKnowledge | null = null;
  if (llm) {
    // A análise de live (Twitch) tem outro olhar e outras categorias: cache separado por modo
    // v2: análise de live mais densa (≈1 momento/30s) e com picos de volume — invalida análises antigas mais rasas
    // Análise feita por modelo gratuito/limitado fica separada: com IA paga o vídeo é reanalisado com mais qualidade
    const kFile = `${cacheBase}.knowledge${s.mode === 'twitch' ? '-twitch-v2' : ''}${llm.free ? '-free' : ''}.json`;
    if (fs.existsSync(kFile)) {
      knowledge = JSON.parse(fs.readFileSync(kFile, 'utf8')) as VideoKnowledge;
      log('info', `Conhecimento do vídeo reaproveitado do cache (${knowledge.moments.length} momentos) — sem reenviar transcrição e frames`);
    } else {
      try {
        log('info', `Analisando o vídeo com ${llm.model} (transcrição${app.sendFramesToAI ? ' + frames' : ''}); o resultado fica em cache`);
        // Lives: os 40 maiores picos de volume (gritos, risadas, sustos) viram pistas textuais baratas para a IA
        const audioPeaks =
          s.mode === 'twitch'
            ? findEnergyPeaks(energy, 1.0, 8)
                .sort((a, b) => energy[b] - energy[a])
                .slice(0, 40)
                .sort((a, b) => a - b)
            : undefined;
        // Trechos agitados: janelas de 20s com mais trocas de cena e áudio mais alto (pistas baratas, só texto)
        const activeWindows =
          s.mode === 'twitch'
            ? Array.from({ length: Math.floor(info.duration / 20) }, (_, i) => {
                const a = i * 20;
                const cuts = scenes.filter((t) => t >= a && t < a + 20).length;
                const vol = energy.slice(a, a + 20).filter((e) => e > -60);
                const loud = vol.length ? vol.reduce((x, y) => x + y, 0) / vol.length : -60;
                return { start: a, end: a + 20, score: cuts * 2 + (loud + 60) / 4 };
              })
                .sort((x, y) => y.score - x.score)
                .slice(0, 10)
                .sort((x, y) => x.start - y.start)
            : undefined;
        knowledge = await aiAnalyzeVideo({ llm, transcript, videoDuration: info.duration, frames, sendImages: app.sendFramesToAI, mode: s.mode, audioPeaks, activeWindows, signal, log: (l, m) => log(l, m) });
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
    let segs = segmentsOf(c).map((sg) => ({ ...snapToSentences(sg.start, sg.end, sentences, info.duration), label: sg.label }));
    // Trechos que se encostam ou se sobrepõem (na ordem de exibição) viram um só: evita repetir fala
    segs = segs.reduce<typeof segs>((acc, sg) => {
      const prev = acc[acc.length - 1];
      if (prev && sg.start <= prev.end + 1.5 && sg.end > prev.start) prev.end = Math.max(prev.end, sg.end);
      else acc.push({ ...sg });
      return acc;
    }, []);
    // Lives: liberdade para estender e fechar o raciocínio; compilação Top 5 tem 5 momentos completos
    // Top N (3 a 5 momentos): sem repetidos e cada um com no máximo ~22s, com o contexto e terminando no fim do pensamento
    if (c.category === 'top5') {
      const unique: typeof segs = [];
      for (const sg of segs) {
        const dup = unique.some((u) => Math.min(u.end, sg.end) - Math.max(u.start, sg.start) > 0.5 * Math.min(u.end - u.start, sg.end - sg.start));
        if (!dup) unique.push(sg);
      }
      if (unique.length < segs.length) log('info', `Top: ${segs.length - unique.length} momento(s) repetido(s) removido(s)`);
      // Menos de 3 momentos bons não é um "Top": descarta em vez de forçar
      if (unique.length < 3) {
        log('info', `"${c.title}" ficou com só ${unique.length} momento(s); compilação descartada`);
        return { ...c, score: 0 };
      }
      segs = unique.slice(0, 5).map((sg) => (sg.end - sg.start > 24 ? { ...snapToSentences(sg.start, sg.start + 22, sentences, info.duration), label: sg.label } : sg));
    }
    const maxDur = c.category === 'top5' ? Math.max(90, s.targetDuration * 2.5) : s.targetDuration * (s.mode === 'twitch' ? 2.5 : 1.6);
    const total = () => segs.reduce((a, sg) => a + (sg.end - sg.start), 0);
    // Corte normal curto demais (momento solto de 7-10s) ganha contexto antes e depois, em frases inteiras.
    // Compilações (top5) são feitas de trechos curtos de propósito.
    const minDur = Math.min(25, s.targetDuration * 0.4);
    if (c.category !== 'top5' && total() < minDur) {
      const before = total();
      // Soma frases INTEIRAS vizinhas (depois e antes, alternando) até atingir o mínimo
      const k = segs.length === 1 ? 0 : segs.length - 1;
      let i0 = sentences.findIndex((x) => x.end > segs[k].start + 0.3);
      let i1 = sentences.length - 1 - [...sentences].reverse().findIndex((x) => x.start < segs[k].end - 0.3);
      if (i0 < 0) i0 = 0;
      if (i1 >= sentences.length || i1 < i0) i1 = i0;
      let turn = 0;
      const span = () => total() - (segs[k].end - segs[k].start) + (sentences[i1].end - sentences[i0].start);
      while (span() < minDur && (i0 > 0 || i1 < sentences.length - 1)) {
        const after = turn++ % 3 !== 2; // 2 frases depois para cada 1 antes: o contexto vem mais da sequência
        if ((after && i1 < sentences.length - 1) || i0 === 0) i1++;
        else if (k === 0) i0--;
        else i1++;
      }
      segs[k] = { start: Math.max(0, sentences[i0].start - 0.15), end: Math.min(info.duration, sentences[i1].end + 0.3), label: segs[k].label };
      log('info', `Corte "${c.title}" tinha só ${before.toFixed(0)}s; ganhou contexto (${total().toFixed(0)}s)`);
    }
    if (total() > maxDur) {
      const before = total();
      // O Top 5 precisa dos 5 momentos: nunca descarta trechos dele
      while (c.category !== 'top5' && segs.length > 1 && total() - (segs[segs.length - 1].end - segs[segs.length - 1].start) >= s.targetDuration * 0.6) segs = segs.slice(0, -1);
      if (total() > maxDur) {
        const last = segs[segs.length - 1];
        const budget = maxDur * 0.95 - (total() - (last.end - last.start));
        segs[segs.length - 1] = { ...snapToSentences(last.start, last.start + Math.max(5, budget), sentences, info.duration), label: last.label };
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
          candidates = await aiSelectFromKnowledge({ llm, knowledge, transcript, settings: s, app: appGuided, videoDuration: info.duration, signal, log: (l, m) => log(l, m) });
        } else {
          log('info', `Enviando transcrição${app.sendFramesToAI && llm.supportsImages ? ' + frames' : ''} para ${llm.name}/${llm.model}`);
          candidates = await aiSelectCandidates({ llm, transcript, settings: s, app: appGuided, videoDuration: info.duration, frames, signal, log: (l, m) => log(l, m) });
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
    const picked = selectClips(candidates, { maxClips: s.maxClips, videoDuration: info.duration, targetDuration: s.targetDuration, minScore: llm ? 70 : 55 });
    return picked.map((c, index) => ({ ...c, segments: segmentsOf(c), index }));
  });
  if (!selected.length) throw new Error('Nenhum corte selecionado.');
  const categoryLabel = (c: ClipCandidate) => TWITCH_CATEGORIES.find((x) => x.key === c.category)?.label ?? c.category ?? '';
  replaceClips(
    job.id,
    selected.map((c) => ({ index: c.index, title: c.title, start: c.start, end: c.end, score: c.score, reason: c.category ? `[${categoryLabel(c)}] ${c.reason}` : c.reason })),
  );
  for (const c of selected) {
    const parts = c.segments.map((sg) => `${sg.start.toFixed(1)}–${sg.end.toFixed(1)}s`).join(' + ');
    log('info', `Corte ${c.index + 1}${c.category ? ` [${categoryLabel(c)}]` : ''}: ${parts} = ${clipDuration(c).toFixed(0)}s (nota ${Math.round(c.score)}) "${c.title}"`);
  }
  progress('select', 1, true);

  // ---------------- 5. Plano de edição ----------------
  begin('plan', `Gerando plano de edição e enquadramento (intensidade ${s.intensity})`);
  const library = scanLibrary();
  // Biblioteca pode ter milhares de arquivos numa pasta só: pré-seleciona pelo NOME os que combinam com
  // o que acontece nos cortes, e só esses são analisados (duração, áudio, fundo verde) e mostrados à IA.
  const clipWords = new Map<number, TranscriptWord[]>(selected.map((c) => [c.index, wordsForSegments(transcript, c.segments)]));
  const contextTexts = selected.flatMap((c) => {
    const moments = (knowledge?.moments ?? []).filter((m) => c.segments.some((sg) => m.end > sg.start && m.start < sg.end));
    return [c.title, c.reason, c.category ?? '', clipWords.get(c.index)!.map((w) => w.word).join(' '), ...moments.map((m) => `${m.type} ${m.topic ?? ''} ${m.description} ${m.visual ?? ''}`)];
  });
  const shortlist = shortlistLibrary(library, contextTexts, { memes: s.useMemes ? 70 : 0, images: 0, audio: s.useSfx ? 60 : 0 }, job.id);
  const assetInfo = new Map<string, AssetInfo>();
  const assetMeta: AssetMeta = {};
  const metaCache = path.join(dataPaths.root, 'cache', 'library-meta.json');
  /** Analisa (com cache) os arquivos visuais indicados e registra em assetInfo/assetMeta. */
  const analyzeRefs = async (refs: { kind: 'memes' | 'images' | 'audio'; cat: string; file: string }[]) => {
    const withPath = refs.map((r) => ({ ...r, full: resolveLibraryFile(library, r.kind, r.cat, r.file) })).filter((r) => r.full && !assetInfo.has(r.full));
    if (!withPath.length) return;
    const infos = await analyzeAssets(withPath.map((r) => r.full!), metaCache);
    for (const r of withPath) {
      const inf = infos.get(r.full!);
      if (!inf) continue;
      assetInfo.set(r.full!, inf);
      assetMeta[`${r.kind}/${r.cat}/${r.file}`] = { duration: inf.duration, hasAudio: inf.hasAudio, greenScreen: inf.greenScreen };
    }
  };
  if (s.useMemes) {
    await analyzeRefs(shortlist.memes.flatMap((c) => c.files.map((file) => ({ kind: 'memes' as const, cat: c.name, file }))));
  }
  if (s.useSfx) {
    // Sons longos (músicas inteiras) virariam trilha por baixo do corte: ficam fora da pré-seleção
    await analyzeRefs(shortlist.audio.flatMap((c) => c.files.map((file) => ({ kind: 'audio' as const, cat: c.name, file }))));
    shortlist.audio = shortlist.audio
      .map((c) => ({ ...c, files: c.files.filter((f) => (assetMeta[`audio/${c.name}/${f}`]?.duration ?? 0) <= 8) }))
      .filter((c) => c.files.length);
  }
  const total = (l: typeof library, k: 'memes' | 'images' | 'audio') => l[k].reduce((a, c) => a + c.files.length, 0);
  log(
    'info',
    `Biblioteca: ${total(library, 'memes')} memes, ${total(library, 'audio')} sons — pré-selecionados pelo nome: ${total(shortlist, 'memes')} memes (${[...assetInfo.values()].filter((x) => x.greenScreen).length} fundo verde, ${[...assetInfo.values()].filter((x) => x.hasAudio).length} com áudio), ${total(shortlist, 'audio')} sons`,
  );
  const catalog = buildCatalog(shortlist, assetMeta);
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
    // Lives: layout decidido POR CORTE (a facecam pode aparecer só em parte da live).
    // facecam visível → facecam + jogo; gameplay sem rosto grande → jogo inteiro, sem zooms; rosto grande → IRL (por pessoa)
    const layouts = new Map<number, ClipLayout>();
    for (const c of selected) {
      if (s.mode !== 'twitch') continue;
      const v = visual.get(c.index)!;
      // Facecam presente em metade dos frames do corte já é fixa (o detector de rosto falha quando a pessoa
      // se mexe, põe a mão no rosto, usa chapéu...); a da live inteira vale como reserva
      const cam = verticalOut && s.twitchLayout !== 'full' ? detectFacecam(v.frames.map((f) => f.faces), 0.5) ?? splitLayout?.cam ?? null : null;
      // Pessoa na câmera cheia (rosto grande, ou de corpo inteiro em boa parte do corte) → enquadramento por pessoa
      const bigFace = v.frames.some((f) => f.faces.some((x) => x.w > 0.15)) || (!cam && v.frames.filter((f) => f.faces.some((x) => x.w > 0.04)).length >= v.frames.length * 0.4);
      // Onde está o conteúdo que se mexe (react: o vídeo assistido) — sem a facecam e sem molduras paradas
      const content = verticalOut && (cam || !bigFace) ? await detectContentRegion(v.frames.map((f) => f.path), cam, signal).catch(() => null) : null;
      layouts.set(c.index, { cam, gameplay: !cam && !bigFace, content });
      const pct = (b: { x0: number; x1: number; y0: number; y1: number }) => `x ${Math.round(b.x0 * 100)}–${Math.round(b.x1 * 100)}%, y ${Math.round(b.y0 * 100)}–${Math.round(b.y1 * 100)}%`;
      log('info', `Corte ${c.index + 1}: layout ${cam ? `facecam (${pct(cam)}) em cima + ${content ? `conteúdo (${pct(content)})` : 'jogo'} embaixo` : !bigFace ? `jogo/conteúdo inteiro${content ? ` (${pct(content)})` : ''}` : 'IRL (enquadramento por pessoa)'}`);
    }
    const fixedLayout = (i: number) => !!(layouts.get(i)?.cam || layouts.get(i)?.gameplay);
    const facesFound = [...visual.values()].reduce((a, v) => a + v.frames.filter((f) => f.faces.length).length, 0);
    log('info', `Análise visual local: ${facesFound} frames com rostos detectados, ${[...visual.values()].reduce((a, v) => a + v.cuts.length, 0)} cortes de câmera nos trechos`);
    let aiEdits = new Map<number, ClipEdit>();
    if (editLlm) {
      try {
        // Imagens para a IA: o 1º frame após cada corte de câmera + amostras regulares, com os rostos descritos
        const clipFrames = new Map<number, { time: number; path: string; note?: string }[]>();
        if (app.sendFramesToAI && editLlm.supportsImages) {
          for (const c of selected) {
            // Layout fixo (facecam/jogo inteiro) não precisa de imagens para enquadrar: economiza tokens
            if (fixedLayout(c.index)) continue;
            const v = visual.get(c.index)!;
            const pick = new Set<number>();
            for (const cut of [0, ...v.cuts]) {
              const i = v.frames.findIndex((f) => f.time >= cut + 0.3);
              if (i >= 0) pick.add(i);
            }
            const step = Math.max(1, Math.floor(v.frames.length / 5));
            for (let i = 0; i < v.frames.length; i += step) pick.add(i);
            // 8 imagens por corte bastam: posição exata vem da detecção local de rostos (economiza tokens)
            const chosen = [...pick].sort((a, b) => a - b).slice(0, 8);
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
          guidelines,
          knowledge,
          sendImages: app.sendFramesToAI,
          assetMeta,
          splitLayout: selected.every((c) => fixedLayout(c.index)),
          catalog: catalog.text,
          // Lives: nada de imagens/ilustrações por cima (só memes em vídeo e sons)
          illustrations: app.useIllustrations && s.mode !== 'twitch',
          signal,
          log: (l, m) => log(l, m),
        });
      } catch (e) {
        if (signal.aborted) throw e;
        log('warn', `Plano por IA falhou (${(e as Error).message}); usando plano heurístico`);
      }
      // Códigos do catálogo (m12, s3...) → arquivos reais; código inexistente fica e é descartado na resolução
      for (const e of aiEdits.values()) {
        for (const o of e.overlays) {
          const entry = o.file ? catalog.byId.get(o.file) : undefined;
          if (entry && entry.kind !== 'audio') Object.assign(o, { file: entry.file, category: entry.category, type: entry.kind === 'images' ? 'image' : 'meme' });
        }
        for (const x of e.sfx) {
          const entry = x.file ? catalog.byId.get(x.file) : undefined;
          if (entry && entry.kind === 'audio') Object.assign(x, { file: entry.file, category: entry.category });
        }
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
      edit.shots = fixedLayout(c.index)
        ? []
        : edit.shots.length
        ? refineShots(edit.shots, ctx)
        : s.format === 'original'
          ? []
          : heuristicShots({ ...ctx, preferWide: s.format !== 'vertical_crop' || s.intensity === 'low' });
      const resolved: ResolvedEdit = { ...resolveEdit(edit, library, seed), layout: layouts.get(c.index) };
      // Trechos emendados: whoosh na transição (o flash é aplicado no render)
      if (c.segments.length > 1 && s.useSfx) {
        let off = 0;
        for (const sg of c.segments.slice(0, -1)) {
          off += sg.end - sg.start;
          if (resolved.sfx.some((x) => Math.abs(x.at - off) < 0.6)) continue;
          const w = findAssetsByKeywords(library, 'audio', ['whoosh', 'swoosh', 'woosh', 'transition', 'swipe'])[0];
          const full = w ? resolveLibraryFile(library, 'audio', w.category, w.file) : null;
          if (full) resolved.sfx.push({ category: w!.category, file: full, fileName: w!.file, at: Math.max(0, off - 0.2), volume: 0.55, duration: 1.2 });
        }
      }
      for (const w of resolved.warnings) log('warn', `Corte ${c.index + 1}: ${w}`);
      return resolved;
    });
  });
  // Ilustrações: a IA pediu imagens do que é falado; o app busca em bancos livres e entra como imagem
  const illustrationCredits = new Map<number, string[]>();
  if (app.useIllustrations) {
    for (const p of plan) {
      for (const il of p.illustrations ?? []) {
        signal.throwIfAborted();
        // Já resolvida num processamento anterior (plano em cache)
        if (p.overlays.some((o) => o.category === ILLUSTRATION_CATEGORY && Math.abs(o.at - il.at) < 0.05)) continue;
        // Meme na tela nesse instante: a ilustração cede o lugar
        if (p.overlays.some((o) => il.at < o.at + o.duration && o.at < il.at + il.duration)) continue;
        const img = await getIllustration(il, { log: (l, m) => log(l, `Corte ${p.clipIndex + 1}: ${m}`), signal, workDir: path.join(tempDir, 'illustrations') }).catch((e) => {
          if (signal.aborted) throw e;
          log('warn', `Corte ${p.clipIndex + 1}: ilustração "${il.label || il.query}" falhou (${(e as Error).message})`);
          return null;
        });
        if (!img) continue;
        p.overlays.push({ type: 'image', category: ILLUSTRATION_CATEGORY, file: img.file, fileName: img.fileName, at: il.at, duration: il.duration, position: il.position, scale: 0.42, audioMode: 'video', reason: il.reason });
        if (img.credit) illustrationCredits.set(p.clipIndex, [...(illustrationCredits.get(p.clipIndex) ?? []), `${il.label || il.query}: ${img.credit}`]);
      }
      p.overlays.sort((a, b) => a.at - b.at);
    }
  }
  // Memes escolhidos fora da pré-seleção (plano heurístico) também precisam de duração/áudio/fundo verde
  await analyzeRefs(plan.flatMap((p) => p.overlays.map((o) => ({ kind: o.type === 'image' ? ('images' as const) : ('memes' as const), cat: o.category, file: o.fileName }))));
  for (const p of plan) {
    for (const o of p.overlays) if (o.reason) log('info', `Corte ${p.clipIndex + 1}: meme "${o.fileName}" em ${o.at.toFixed(1)}s (áudio: ${o.audioMode}) — ${o.reason}`);
    const shotKinds = p.shots.length ? ` (${p.shots.filter((x) => x.type === 'wide').length} abertos, ${p.shots.filter((x) => x.type === 'focus' && x.scale >= 1.3).length} aproximações)` : '';
    log('info', `Corte ${p.clipIndex + 1}: ${p.shots.length} enquadramentos${shotKinds}, ${p.zooms.length} zooms, ${p.overlays.length} memes, ${p.sfx.length} efeitos sonoros`);
    // Créditos do vídeo original (Creative Commons) sempre ao fim da descrição
    const credit = creditLine(s);
    if (credit && !p.description?.includes(credit)) p.description = [p.description, credit].filter(Boolean).join('\n\n');
    // Licenças CC BY / BY-SA das ilustrações pedem crédito
    const imgCredits = illustrationCredits.get(p.clipIndex);
    if (imgCredits?.length) p.description = [p.description, `Imagens: ${[...new Set(imgCredits)].join('; ')}`].filter(Boolean).join('\n\n');
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
      // No layout facecam + jogo a legenda fica na emenda entre as duas partes
      const ass = s.burnSubtitles
        ? buildAss(translatedWords ?? words, {
            width: canvas.width,
            height: canvas.height,
            intensity: s.intensity,
            baseline: edit.layout?.cam ? 0.53 : undefined,
            rankCards: c.category === 'top5' ? rankCardsFor(c.segments) : undefined,
          })
        : undefined;
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

      const pauses = planSoundPauses(
        edit.sfx.map((x) => ({ file: x.file, at: x.at, volume: x.volume, duration: x.duration ?? assetInfo.get(x.file)?.duration })),
        words,
        duration,
      );
      if (pauses.length) log('info', `Corte ${c.index + 1}: ${pauses.length} som(ns) com o vídeo pausado (${pauses.map((p) => `${p.at.toFixed(1)}s`).join(', ')})`);
      await renderClip({
        input,
        start,
        end: start + duration,
        source: input === job.inputPath ? info : { ...info, hasAudio: true },
        // Gameplay sem facecam: o jogo inteiro na tela (fundo desfocado), nunca um recorte do meio do jogo
        format: edit.layout?.gameplay && s.format === 'vertical_crop' ? 'vertical_blur' : s.format,
        flashAt: c.segments.length > 1 ? c.segments.slice(0, -1).reduce<number[]>((acc, sg) => [...acc, (acc[acc.length - 1] ?? 0) + sg.end - sg.start], []) : [],
        shots: edit.shots,
        cleanArea,
        split: edit.layout?.cam ? { cam: edit.layout.cam } : null,
        content: edit.layout?.content ?? null,
        zooms: edit.zooms,
        overlays: edit.overlays.map((o) => {
          const inf = assetInfo.get(o.file);
          // Meme em vídeo toca inteiro (até 6s), mesmo que a IA tenha pedido menos
          const dur = inf && inf.duration > 0 ? Math.min(Math.max(o.duration, Math.min(inf.duration, 6)), inf.duration) : o.duration;
          return { file: o.file, at: o.at, duration: dur, position: o.position, scale: o.scale, hasAudio: inf?.hasAudio ?? assetAudio.get(o.file), volume: 0.9, greenScreen: inf?.greenScreen, keyColor: inf?.keyColor, audioMode: o.audioMode };
        }),
        // Efeitos sonoros viram PAUSAS: o vídeo congela, o som toca sozinho e o vídeo continua (nunca por cima da fala)
        pauses,
        sfx: [],
        assContent: ass,
        output: `${base}.mp4`,
        workDir,
        hwAccel: app.hwAccel,
        threads: app.threads,
        signal,
        onProgress: (p) => tick(input === job.inputPath ? p * 0.95 : 0.5 + p * 0.45),
      });
      await extractThumbnail(`${base}.mp4`, `${base}.jpg`, Math.min(1.5, duration / 2)).catch(() => undefined);
      const pausedTotal = pauses.reduce((a, p) => a + p.duration, 0);

      let srtPath: string | null = null;
      const srtFiles: Record<string, string> = {};
      if (s.exportSrt) {
        srtPath = `${base}.srt`;
        fs.writeFileSync(srtPath, buildSrt(shiftForPauses(words, pauses)), 'utf8');
        srtFiles[transcript.language] = path.basename(srtPath);
        if (translatedWords) {
          const tp = `${base}.${s.translateTo}.srt`;
          fs.writeFileSync(tp, buildSrt(shiftForPauses(translatedWords, pauses)), 'utf8');
          srtFiles[s.translateTo] = path.basename(tp);
        }
      }
      const meta = {
        index: c.index + 1,
        title: c.title,
        category: c.category ?? null,
        layout: edit.layout?.cam ? 'facecam+jogo' : edit.layout?.gameplay ? 'jogo inteiro' : 'normal',
        score: Math.round(c.score),
        reason: c.reason,
        hook: c.hook ?? null,
        description: edit.description ?? null,
        hashtags: edit.hashtags,
        source: { file: path.basename(job.inputPath), start: c.start, end: c.end, segments: c.segments },
        duration: Number((duration + pausedTotal).toFixed(3)),
        format: s.format,
        resolution: `${canvas.width}x${canvas.height}`,
        intensity: s.intensity,
        language: transcript.language,
        translatedTo: translatedWords ? s.translateTo : null,
        subtitlesBurned: s.burnSubtitles,
        oldSubtitlesRemoved: !!subRegion,
        provider: result.provider,
        // Tudo que é preciso para refazer SÓ este corte depois (ajuste por comentário), sem reprocessar o vídeo
        renderContext: {
          input: job.inputPath,
          jobId: job.id,
          clipIndex: c.index,
          format: edit.layout?.gameplay && s.format === 'vertical_crop' ? 'vertical_blur' : s.format,
          cleanArea,
          inpaintRegion,
          layout: edit.layout ?? null,
          category: c.category ?? null,
          segments: c.segments,
        },
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

/** Top 5: um card por trecho (contagem regressiva, o melhor por último); o placar acumula na legenda. */
export function rankCardsFor(segments: ClipSegment[]): { at: number; end: number; rank: number; label: string }[] {
  let off = 0;
  return segments.map((sg, i) => {
    const card = { at: off, end: off + sg.end - sg.start, rank: segments.length - i, label: sg.label ?? '' };
    off += sg.end - sg.start;
    return card;
  });
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
