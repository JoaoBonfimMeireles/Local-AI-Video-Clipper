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
  type ClipEdit,
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
        system: SELECTION_SYSTEM,
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
  clips: { index: number; duration: number; title: string; words: TranscriptWord[] }[];
  settings: JobSettings;
  library: LibraryIndex;
  log: Log;
  signal?: AbortSignal;
}): Promise<Map<number, ClipEdit>> {
  const out = new Map<number, ClipEdit>();
  const BATCH = 4;
  for (let b = 0; b < args.clips.length; b += BATCH) {
    const batch = args.clips.slice(b, b + BATCH);
    const plan = await askJson(
      args.llm,
      {
        system: PLAN_SYSTEM,
        prompt: buildPlanPrompt({
          clips: batch.map((c) => ({ index: c.index, duration: c.duration, title: c.title, transcript: wordsToTimedText(c.words) })),
          settings: args.settings,
          library: args.library,
        }),
        signal: args.signal,
      },
      EditPlanSchema,
      args.log,
    );
    for (const e of plan.clips) if (batch.some((c) => c.index === e.clipIndex)) out.set(e.clipIndex, e);
  }
  return out;
}

/** Texto com tempos relativos agrupado em frases de ~8 palavras: "[3.2] palavras ...". */
function wordsToTimedText(words: TranscriptWord[]): string {
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
  log: Log;
  signal?: AbortSignal;
}): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const BATCH = 40;
  for (let i = 0; i < args.segments.length; i += BATCH) {
    const items = args.segments.slice(i, i + BATCH);
    const res = await askJson(
      args.llm,
      { system: 'Você é um tradutor profissional de legendas. Responda SOMENTE com JSON.', prompt: buildTranslationPrompt(items, args.targetLang, args.sourceLang), temperature: 0.2, signal: args.signal },
      TranslationSchema,
      args.log,
    );
    for (const t of res.translations) out.set(t.id, t.text);
  }
  return out;
}
