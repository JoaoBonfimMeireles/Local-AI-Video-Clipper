import type { Transcript } from '@clipper/shared';
import { buildSentences, snapToSentences, type Sentence } from './sentences';

export interface ClipSegment {
  start: number;
  end: number;
  /** Título curto do momento (cartões numerados do Top 5). */
  label?: string | null;
}

export interface ClipCandidate {
  start: number;
  end: number;
  /** Trechos que compõem o corte, na ordem de exibição. Ausente = [start, end] contínuo. */
  segments?: ClipSegment[];
  /** Modo Twitch: tipo de momento (funny, scary, top5...). */
  category?: string;
  /** Formato da faixa de ouro dos Shorts: "loop" (15-20s) ou "story" (20-40s). */
  shortFormat?: 'loop' | 'story' | null;
  score: number;
  title: string;
  reason: string;
  hook?: string;
}

// Léxico multilíngue (pt/en/es) de gatilhos de retenção.
const HOOK_WORDS = [
  'segredo', 'ninguém', 'nunca', 'verdade', 'incrível', 'absurdo', 'impossível', 'erro', 'pior', 'melhor', 'dinheiro', 'milionário',
  'cuidado', 'atenção', 'polêmica', 'polêmico', 'chocante', 'surpresa', 'descobri', 'mentira', 'perigo', 'sério', 'loucura', 'lição',
  'secret', 'nobody', 'never', 'truth', 'crazy', 'insane', 'mistake', 'worst', 'best', 'money', 'million', 'shocking', 'lie', 'lesson',
  'secreto', 'nadie', 'nunca', 'verdad', 'increíble', 'locura', 'dinero', 'error',
];
const LAUGH_RE = /\b(k{3,}|(ha){2,}|(he){2,}|rs{2,}|risos|lol|jaja(ja)*)\b/i;
const NUMBER_RE = /\b\d+([.,]\d+)?\b|\b(mil|milhões|bilhões|por cento|percent|thousand|million)\b/i;

function normalize(t: string) {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
const HOOK_SET = new Set(HOOK_WORDS.map(normalize));

function sentenceSignals(s: Sentence) {
  const text = normalize(s.text);
  const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
  const hooks = tokens.filter((t) => HOOK_SET.has(t)).length;
  return {
    question: /\?/.test(s.text) ? 1 : 0,
    exclaim: (s.text.match(/!/g) ?? []).length,
    laugh: LAUGH_RE.test(text) ? 1 : 0,
    hooks,
    numbers: NUMBER_RE.test(text) ? 1 : 0,
    words: tokens.length,
  };
}

export interface HeuristicOptions {
  targetDuration: number;
  videoDuration: number;
  /** RMS em dB por segundo (de analyzeEnergy). */
  energy?: number[];
  sceneChanges?: number[];
}

/** Gera candidatos por janela deslizante sobre frases, pontuando gatilhos de retenção. */
export function heuristicCandidates(transcript: Transcript, opts: HeuristicOptions): ClipCandidate[] {
  const sentences = buildSentences(transcript);
  if (!sentences.length) return [];
  const target = Math.max(10, opts.targetDuration);
  const minDur = target * 0.6;
  const maxDur = target * 1.5;
  const signals = sentences.map(sentenceSignals);

  const energy = opts.energy ?? [];
  const voiced = energy.filter((e) => e > -60);
  const eMean = voiced.length ? voiced.reduce((a, b) => a + b, 0) / voiced.length : 0;
  const eStd = voiced.length ? Math.sqrt(voiced.reduce((a, b) => a + (b - eMean) ** 2, 0) / voiced.length) || 1 : 1;
  const totalWords = signals.reduce((a, s) => a + s.words, 0);
  const globalRate = totalWords / Math.max(1, sentences[sentences.length - 1].end - sentences[0].start);

  const out: ClipCandidate[] = [];
  for (let i = 0; i < sentences.length; i++) {
    let best: { j: number; score: number } | null = null;
    for (let j = i; j < sentences.length; j++) {
      const dur = sentences[j].end - sentences[i].start;
      if (dur > maxDur) break;
      if (dur < minDur) continue;
      // Preferir fins com pausa natural e duração próxima do alvo
      const closeness = 1 - Math.min(1, Math.abs(dur - target) / target);
      const pause = Math.min(1, sentences[j].gapAfter / 1.0);
      const endsClean = /[.!?…]$/.test(sentences[j].text.trim()) ? 1 : 0;
      const s = closeness * 0.6 + pause * 0.25 + endsClean * 0.15;
      if (!best || s > best.score) best = { j, score: s };
    }
    if (!best) continue;

    const win = sentences.slice(i, best.j + 1);
    const sig = signals.slice(i, best.j + 1);
    const start = win[0].start;
    const end = win[win.length - 1].end;
    const dur = end - start;

    const hooksPerMin = (sig.reduce((a, s) => a + s.hooks, 0) / dur) * 60;
    const emotion = sig.reduce((a, s) => a + s.exclaim + s.laugh * 2, 0);
    const questions = sig.reduce((a, s) => a + s.question, 0);
    const numbers = sig.reduce((a, s) => a + s.numbers, 0);
    const rate = sig.reduce((a, s) => a + s.words, 0) / dur / Math.max(0.5, globalRate);
    const openingHook = signals[i].question || signals[i].hooks > 0 || signals[i].numbers ? 1 : 0;

    let energyScore = 0.5;
    if (energy.length) {
      const slice = energy.slice(Math.floor(start), Math.ceil(end)).filter((e) => e > -60);
      if (slice.length) {
        const m = slice.reduce((a, b) => a + b, 0) / slice.length;
        const peaks = slice.filter((e) => e > eMean + 1.2 * eStd).length;
        energyScore = Math.min(1, Math.max(0, 0.5 + (m - eMean) / (3 * eStd) + peaks / slice.length));
      }
    }

    const raw =
      Math.min(1, hooksPerMin / 6) * 26 +
      Math.min(1, emotion / 4) * 16 +
      Math.min(1, questions / 2) * 10 +
      Math.min(1, numbers / 2) * 8 +
      Math.min(1, Math.max(0, rate - 0.7)) * 10 +
      openingHook * 14 +
      energyScore * 10 +
      best.score * 6;
    const score = Math.round(Math.min(100, Math.max(0, raw)));

    const reasons: string[] = [];
    if (openingHook) reasons.push('abre com gancho (pergunta/número/palavra forte)');
    if (hooksPerMin >= 3) reasons.push('alta densidade de palavras-gatilho');
    if (emotion >= 2) reasons.push('picos emocionais (exclamações/risadas)');
    if (questions) reasons.push('contém pergunta e resposta');
    if (energyScore > 0.65) reasons.push('energia de áudio acima da média');
    if (!reasons.length) reasons.push('trecho coeso com começo e fim naturais');

    const strongest = win.reduce((a, s, k) => (sig[k].hooks + sig[k].exclaim + sig[k].question > a.v ? { v: sig[k].hooks + sig[k].exclaim + sig[k].question, s } : a), { v: -1, s: win[0] }).s;
    out.push({
      start,
      end,
      score,
      title: makeTitle(strongest.text),
      reason: reasons.join('; '),
      hook: win[0].text.slice(0, 160),
    });
  }
  return out.map((c) => ({ ...c, ...snapToSentences(c.start, c.end, sentences, opts.videoDuration) }));
}

function makeTitle(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const t = words.slice(0, 9).join(' ');
  return (t.length > 70 ? t.slice(0, 67) + '...' : t).replace(/[.,;:]+$/, '') || 'Corte';
}
