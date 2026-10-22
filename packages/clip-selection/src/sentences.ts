import { flattenWords, type Transcript, type TranscriptWord } from '@clipper/shared';

export interface Sentence {
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
  /** Silêncio até a próxima frase (s). Pausas longas são bons pontos de corte. */
  gapAfter: number;
}

const TERMINAL = /[.!?…]["')\]]?$/;

/** Quebra o transcript em frases usando pontuação e pausas longas. */
export function buildSentences(transcript: Transcript, maxSentenceSec = 20): Sentence[] {
  const words = flattenWords(transcript.segments);
  const sentences: Sentence[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    if (!cur.length) return;
    sentences.push({
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      text: cur.map((w) => w.word).join(' '),
      words: cur,
      gapAfter: 0,
    });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    cur.push(w);
    const gap = next ? next.start - w.end : Infinity;
    const tooLong = w.end - cur[0].start > maxSentenceSec;
    if (TERMINAL.test(w.word) || gap > 1.2 || tooLong) flush();
  }
  flush();
  for (let i = 0; i < sentences.length; i++) {
    sentences[i].gapAfter = i < sentences.length - 1 ? Math.max(0, sentences[i + 1].start - sentences[i].end) : 2;
  }
  // Transcript sem palavras (fallback): usa segmentos
  if (!sentences.length) {
    for (const s of transcript.segments) {
      sentences.push({ start: s.start, end: s.end, text: s.text, words: [], gapAfter: 0.5 });
    }
  }
  return sentences;
}

/**
 * Ajusta [start, end] para não cortar frases ao meio: início no começo de uma frase,
 * fim no final de uma frase, com pequeno respiro de áudio.
 */
export function snapToSentences(start: number, end: number, sentences: Sentence[], videoDuration: number): { start: number; end: number } {
  if (!sentences.length) return { start, end };
  // início: frase que contém `start` (ou a primeira que começa depois)
  let s = sentences.find((x) => x.end > start + 0.3) ?? sentences[0];
  if (start - s.start > (s.end - s.start) * 0.6) {
    const idx = sentences.indexOf(s);
    s = sentences[idx + 1] ?? s;
  }
  // fim: última frase que termina até `end` + tolerância
  const candidates = sentences.filter((x) => x.start >= s.start && x.end <= end + 2.5);
  let e = candidates[candidates.length - 1] ?? s;
  if (e.end < s.start) e = s;
  const startT = Math.max(0, s.start - 0.15);
  const endT = Math.min(videoDuration, e.end + Math.min(0.4, e.gapAfter * 0.6));
  return { start: round3(startT), end: round3(Math.max(endT, startT + 1)) };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Palavras de um corte com vários trechos, com tempos na linha do tempo do corte (trechos emendados). */
export function wordsForSegments(transcript: Transcript, segments: { start: number; end: number }[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let offset = 0;
  for (const seg of segments) {
    for (const w of wordsInRange(transcript, seg.start, seg.end)) out.push({ ...w, start: w.start + offset, end: w.end + offset });
    offset += seg.end - seg.start;
  }
  return out;
}

/** Palavras do intervalo, com tempos relativos ao início do corte. */
export function wordsInRange(transcript: Transcript, start: number, end: number): TranscriptWord[] {
  return flattenWords(transcript.segments)
    .filter((w) => w.end > start && w.start < end)
    .map((w) => ({ ...w, start: Math.max(0, w.start - start), end: Math.min(end - start, w.end - start) }));
}
