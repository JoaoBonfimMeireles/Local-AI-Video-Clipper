import type { AppSettings, JobSettings, LibraryIndex, Transcript, TranscriptWord } from '@clipper/shared';
import {
  buildPlanPrompt,
  buildSelectionPrompt,
  buildTranslationPrompt,
  CandidateListSchema,
  compactTranscript,
  EditPlanSchema,
  extractJson,
  parseWith,
  PLAN_SYSTEM,
  SELECTION_SYSTEM,
  TranslationSchema,
  withGuidelines,
  ANALYSIS_SYSTEM,
  ANALYSIS_SYSTEM_TWITCH,
  type AssetMeta,
  buildAnalysisPrompt,
  buildSelectionFromKnowledgePrompt,
  VideoKnowledgeSchema,
  type ClipEdit,
  type VideoKnowledge,
} from '@clipper/editing-planner';
import type { ClipCandidate } from '@clipper/clip-selection';
import type { z } from 'zod';
import { imageFromFile, type LLMProvider, type LLMRequest } from './llm';

type Log = (level: 'info' | 'warn', msg: string) => void;

/** Chama a LLM, extrai JSON e valida com Zod. Em caso de JSON inválido, pede correção uma vez. */
export async function askJson<T>(llm: LLMProvider, req: LLMRequest, schema: z.ZodType<T>, log: Log, attempts = 2): Promise<T> {
  let prompt = req.prompt;
  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    const text = await llm.complete({ ...req, prompt });
    let raw: unknown;
    try {
      raw = extractJson(text);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      log('warn', `IA retornou JSON ilegível (tentativa ${i + 1}): ${lastError}`);
      prompt = `${req.prompt}\n\nSua resposta anterior não era JSON válido. Responda SOMENTE com o JSON pedido.`;
      continue;
    }
    const parsed = parseWith(schema, raw);
    if (parsed.ok) return parsed.data;
    lastError = parsed.error;
    log('warn', `JSON da IA não passou na validação (tentativa ${i + 1}): ${lastError}`);
    prompt = `${req.prompt}\n\nSua resposta anterior falhou na validação: ${lastError}\nCorrija e responda SOMENTE com o JSON.`;
  }
  throw new Error(`IA não produziu JSON válido: ${lastError}`);
}

interface FrameRef {
  time: number;
  reason: string;
  path: string;
}

/** Divide o transcript em blocos que cabem no contexto do modelo, com sobreposição. */
function chunkTranscript(t: Transcript, maxChars: number): { from: number; to: number; text: string }[] {
  const full = compactTranscript(t);
  if (full.length <= maxChars) return [{ from: 0, to: t.duration, text: full }];
  const chunks: { from: number; to: number; text: string }[] = [];
  let i = 0;
  const segs = t.segments;
  while (i < segs.length) {
    let len = 0;
    let j = i;
    while (j < segs.length && len + segs[j].text.length + 20 < maxChars) len += segs[j++].text.length + 20;
    j = Math.max(j, i + 1);
    const from = segs[i].start;
    const to = segs[j - 1].end;
    chunks.push({ from, to, text: compactTranscript(t, from, to) });
    if (j >= segs.length) break;
    // sobreposição de ~90s para não perder cortes na fronteira
    let back = j - 1;
    while (back > i + 1 && segs[j - 1].end - segs[back].start < 90) back--;
    i = Math.max(i + 1, back);
  }
  return chunks;
}

export async function aiSelectCandidates(args: {
  llm: LLMProvider;
  transcript: Transcript;
  settings: JobSettings;
  app: AppSettings;
  videoDuration: number;
  frames?: FrameRef[];
  log: Log;
  signal?: AbortSignal;
}): Promise<ClipCandidate[]> {
  const { llm, transcript, settings } = args;
  const chunks = chunkTranscript(transcript, llm.maxPromptChars);
  if (chunks.length > 1) args.log('info', `Transcrição dividida em ${chunks.length} blocos para o modelo ${llm.model}`);
  const all: ClipCandidate[] = [];
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const frames = (args.frames ?? []).filter((f) => f.time >= chunk.from && f.time <= chunk.to);
    const visualNotes = frames.length ? frames.map((f, i) => `imagem ${i + 1}: t=${f.time.toFixed(1)}s (${f.reason})`).join('\n') : undefined;
    const sendImages = args.app.sendFramesToAI && llm.supportsImages;
    const images = sendImages ? frames.slice(0, 12).map((f) => imageFromFile(f.path)) : undefined;
    const result = await askJson(
      llm,
      {
        system: withGuidelines(SELECTION_SYSTEM, args.app.editingPrompt),
        prompt: buildSelectionPrompt({
          transcriptText: chunk.text,
          settings,
          videoDuration: args.videoDuration,
          visualNotes: visualNotes && (sendImages ? `${visualNotes}\n(as imagens anexadas seguem esta ordem)` : visualNotes),
          chunkInfo: chunks.length > 1 ? `Este é o bloco ${c + 1}/${chunks.length} (de ${chunk.from.toFixed(0)}s a ${chunk.to.toFixed(0)}s).` : '',
        }),
        images,
        signal: args.signal,
      },
      CandidateListSchema,
      args.log,
    );
    all.push(
      ...result.clips
        .filter((x) => x.start >= chunk.from - 5 && x.end <= chunk.to + 5)
        .map((x) => ({ start: x.start, end: Math.min(x.end, args.videoDuration), score: x.score, title: x.title, reason: x.reason, hook: x.hook })),
    );
  }
  return all;
}

export async function aiPlanEdits(args: {
  llm: LLMProvider;
  clips: { index: number; duration: number; title: string; words: TranscriptWord[]; frames?: { time: number; path: string; note?: string }[]; cuts?: number[] }[];
  settings: JobSettings;
  library: LibraryIndex;
  language: string;
  guidelines?: string;
  knowledge?: VideoKnowledge | null;
  sendImages?: boolean;
  assetMeta?: AssetMeta;
  splitLayout?: boolean;
  catalog?: string;
  illustrations?: boolean;
  log: Log;
  signal?: AbortSignal;
}): Promise<Map<number, ClipEdit>> {
  const out = new Map<number, ClipEdit>();
  // Com imagens, lotes menores mantêm cada chamada leve (o plano gratuito limita tokens por minuto)
  const withImages = !!args.sendImages && args.llm.supportsImages && args.clips.some((c) => c.frames?.length);
  // Um corte por imagem ~250 tokens: 4 cortes x 16 imagens cabem com folga numa chamada (economiza cota)
  const BATCH = 4;
  for (let b = 0; b < args.clips.length; b += BATCH) {
    const batch = args.clips.slice(b, b + BATCH);
    const images: ReturnType<typeof imageFromFile>[] = [];
    const visualByClip = new Map<number, string>();
    for (const c of batch) {
      const lines: string[] = [];
      if (c.cuts?.length) lines.push(`Cortes de câmera no vídeo original (o conteúdo muda de lugar): t=${c.cuts.map((t) => t.toFixed(1)).join(', ')}s`);
      if (!c.frames?.length) {
        if (lines.length) visualByClip.set(c.index, lines.join('\n'));
        continue;
      }
      for (const fr of c.frames) {
        if (withImages) {
          images.push(imageFromFile(fr.path));
          lines.push(`imagem ${images.length}: t=${fr.time.toFixed(1)}s${fr.note ? ` — ${fr.note}` : ''}`);
        }
      }
      if (lines.length) visualByClip.set(c.index, lines.join('\n'));
    }
    const plan = await askJson(
      args.llm,
      {
        system: withGuidelines(PLAN_SYSTEM, args.guidelines),
        prompt: buildPlanPrompt({
          clips: batch.map((c) => ({ index: c.index, duration: c.duration, title: c.title, transcript: wordsToTimedText(c.words) })),
          settings: args.settings,
          library: args.library,
          language: args.language,
          knowledge: args.knowledge,
          visualByClip,
          assetMeta: args.assetMeta,
          splitLayout: args.splitLayout,
          catalog: args.catalog,
          illustrations: args.illustrations,
        }),
        images: images.length ? images : undefined,
        signal: args.signal,
      },
      EditPlanSchema,
      args.log,
    );
    for (const e of plan.clips) if (batch.some((c) => c.index === e.clipIndex)) out.set(e.clipIndex, e);
  }
  return out;
}

/**
 * Análise reutilizável do vídeo (resumo, pessoas, momentos). É feita uma vez por vídeo e guardada
 * em cache: reprocessar o mesmo vídeo com outra edição não reenvia transcrição nem frames.
 */
export async function aiAnalyzeVideo(args: {
  llm: LLMProvider;
  transcript: Transcript;
  videoDuration: number;
  frames?: FrameRef[];
  sendImages: boolean;
  mode?: 'youtube' | 'twitch';
  /** Picos de volume (segundos absolutos) — pistas de gritos/risadas para lives. */
  audioPeaks?: number[];
  /** Janelas mais agitadas (muitas trocas de cena + áudio alto), em segundos absolutos. */
  activeWindows?: { start: number; end: number }[];
  log: Log;
  signal?: AbortSignal;
}): Promise<VideoKnowledge> {
  const chunks = chunkTranscript(args.transcript, args.llm.maxPromptChars);
  const parts: VideoKnowledge[] = [];
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const useImages = args.sendImages && args.llm.supportsImages;
    // As imagens enviadas e a lista descrita têm de ser AS MESMAS, espalhadas pelo bloco inteiro
    // (antes só as 12 primeiras iam e o fim do vídeo ficava sem imagem)
    const all = (args.frames ?? []).filter((f) => f.time >= chunk.from && f.time <= chunk.to);
    const cap = args.llm.free ? 12 : 72;
    const frames = all.length <= cap ? all : Array.from({ length: cap }, (_, i) => all[Math.floor((i * all.length) / cap)]);
    const visualNotes = frames.length ? frames.map((f, i) => `imagem ${i + 1}: t=${f.time.toFixed(1)}s (${f.reason})`).join('\n') : undefined;
    const gaps = silentGaps(args.transcript, chunk.from, chunk.to);
    parts.push(
      await askJson(
        args.llm,
        {
          system: args.mode === 'twitch' ? ANALYSIS_SYSTEM_TWITCH : ANALYSIS_SYSTEM,
          prompt: buildAnalysisPrompt({
            mode: args.mode,
            audioPeaks: (args.audioPeaks ?? []).filter((t) => t >= chunk.from && t <= chunk.to).map((t) => `${t.toFixed(0)}s`).join(', ') || undefined,
            activeWindows: (args.activeWindows ?? []).filter((w) => w.end >= chunk.from && w.start <= chunk.to).map((w) => `${w.start.toFixed(0)}-${w.end.toFixed(0)}s`).join(', ') || undefined,
            transcriptText: chunk.text,
            videoDuration: args.videoDuration,
            visualNotes: useImages ? visualNotes : undefined,
            silentGaps: gaps.length ? gaps.map((g) => `${g.start.toFixed(0)}-${g.end.toFixed(0)}s`).join(', ') : undefined,
            chunkInfo: chunks.length > 1 ? `Este é o bloco ${c + 1}/${chunks.length} (de ${chunk.from.toFixed(0)}s a ${chunk.to.toFixed(0)}s).` : '',
          }),
          images: useImages ? frames.map((f) => imageFromFile(f.path)) : undefined,
          maxTokens: 32768,
          signal: args.signal,
        },
        VideoKnowledgeSchema,
        args.log,
      ),
    );
  }
  if (parts.length === 1) return parts[0];
  // Junta os blocos: resumo do primeiro + momentos de todos (sem duplicar sobreposições)
  const moments = parts.flatMap((p) => p.moments).sort((a, b) => a.start - b.start);
  const dedup = moments.filter((m, i) => i === 0 || m.start >= moments[i - 1].end - 1);
  return {
    summary: parts.map((p) => p.summary).join(' '),
    format: parts[0].format,
    speakers: parts[0].speakers,
    topics: [...new Set(parts.flatMap((p) => p.topics))].slice(0, 30),
    moments: dedup.slice(0, 200),
  };
}

/** Seleção de cortes usando só a análise em cache (bem menos tokens que transcrição + frames). */
export async function aiSelectFromKnowledge(args: {
  llm: LLMProvider;
  knowledge: VideoKnowledge;
  settings: JobSettings;
  app: AppSettings;
  videoDuration: number;
  /** Transcrição completa: mostra onde cada ideia começa e termina (vai junto quando cabe no orçamento). */
  transcript?: Transcript;
  log: Log;
  signal?: AbortSignal;
}): Promise<ClipCandidate[]> {
  // Com IA paga a transcrição inteira vai junto (contexto completo); no gratuito, só se for curta
  let transcriptText: string | undefined;
  if (args.transcript) {
    const t = compactTranscript(args.transcript);
    if (t.length <= (args.llm.free ? 15_000 : 160_000)) transcriptText = t;
  }
  const res = await askJson(
    args.llm,
    {
      system: withGuidelines(SELECTION_SYSTEM, args.app.editingPrompt),
      prompt: buildSelectionFromKnowledgePrompt({ knowledge: args.knowledge, settings: args.settings, videoDuration: args.videoDuration, transcriptText }),
      signal: args.signal,
    },
    CandidateListSchema,
    args.log,
  );
  return res.clips.map((x) => ({
    start: x.start,
    end: Math.min(x.end, args.videoDuration),
    segments: x.segments.map((sg) => ({ start: sg.start, end: Math.min(sg.end, args.videoDuration), label: sg.label ?? null })).filter((sg) => sg.end > sg.start + 1),
    score: x.score,
    title: x.title,
    reason: x.reason,
    hook: x.hook,
    category: x.category,
    shortFormat: x.shortFormat ?? null,
  }));
}

/** Trechos de 4s+ sem nenhuma fala: ali a história anda só pela imagem (alguém faz algo, a cena muda). */
export function silentGaps(t: Transcript, from = 0, to = Infinity): { start: number; end: number }[] {
  const segs = t.segments.filter((s) => s.end > from && s.start < to);
  const out: { start: number; end: number }[] = [];
  let prev = Math.max(0, from);
  for (const s of segs) {
    if (s.start - prev >= 4) out.push({ start: prev, end: s.start });
    prev = Math.max(prev, s.end);
  }
  return out;
}

/** Texto com tempos relativos agrupado em frases de ~8 palavras: "[3.2] palavras ...". */
export function wordsToTimedText(words: TranscriptWord[]): string {
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += 8) {
    const g = words.slice(i, i + 8);
    lines.push(`[${g[0].start.toFixed(1)}] ${g.map((w) => w.word).join(' ')}`);
  }
  return lines.join('\n');
}

export async function translateSegments(args: {
  llm: LLMProvider;
  segments: { id: number; text: string }[];
  targetLang: string;
  sourceLang: string;
  guidelines?: string;
  log: Log;
  signal?: AbortSignal;
}): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const BATCH = 220;
  for (let i = 0; i < args.segments.length; i += BATCH) {
    const items = args.segments.slice(i, i + BATCH);
    const res = await askJson(
      args.llm,
      { system: withGuidelines('Você é um tradutor profissional de legendas. Responda SOMENTE com JSON.', args.guidelines), prompt: buildTranslationPrompt(items, args.targetLang, args.sourceLang), temperature: 0.2, signal: args.signal },
      TranslationSchema,
      args.log,
    );
    for (const t of res.translations) out.set(t.id, t.text);
  }
  return out;
}
