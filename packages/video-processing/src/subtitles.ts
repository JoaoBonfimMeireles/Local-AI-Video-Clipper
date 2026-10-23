// Geração de legendas: ASS dinâmico (estilo "Hormozi": palavra ativa destacada) e SRT.
import type { Intensity, TranscriptWord } from '@clipper/shared';

export interface CaptionWord extends TranscriptWord {
  /** Palavra a enfatizar (cor alternativa). */
  emphasis?: boolean;
}

export interface AssOptions {
  width: number;
  height: number;
  intensity: Intensity;
  /** Fração da altura onde fica a base da legenda (0 = topo, 1 = base). */
  baseline?: number;
  /** Cartões de ranking (Top 5): número grande + título curto, no lado esquerdo, durante cada momento. */
  rankCards?: { at: number; end: number; rank: number; label: string }[];
}

const HIGHLIGHT = '&H0000E5FF&'; // amarelo (ASS usa BGR)
const EMPHASIS = '&H0050FF3C&'; // verde
const WHITE = '&H00FFFFFF&';

function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

/** Remove caracteres que o ASS interpreta como comandos. */
function escapeAss(text: string): string {
  return text.replace(/\\/g, '/').replace(/[{}]/g, '').replace(/\r?\n/g, ' ');
}

function cleanWord(w: string): string {
  return w.trim();
}

/** Agrupa palavras em blocos curtos, quebrando em pausas e pontuação. */
export function chunkWords<T extends TranscriptWord>(words: T[], maxWords: number, maxChars: number, maxGap = 0.6): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const text = cleanWord(w.word);
    if (!text) continue;
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length && (cur.length >= maxWords || chars + text.length + 1 > maxChars || gap > maxGap)) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(w);
    chars += text.length + 1;
    if (/[.!?…]$/.test(text) || (/[,;:]$/.test(text) && cur.length >= Math.ceil(maxWords / 2))) {
      chunks.push(cur);
      cur = [];
      chars = 0;
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export function buildAss(words: CaptionWord[], opts: AssOptions): string {
  const { width: W, height: H, intensity } = opts;
  const vertical = H > W;
  const hormozi = intensity !== 'low';
  const fontSize = Math.round((vertical ? W * 0.088 : H * 0.075) * (hormozi ? 1 : 0.75));
  const outline = Math.max(2, Math.round(fontSize * (hormozi ? 0.09 : 0.06)));
  const baseline = opts.baseline ?? (vertical ? 0.72 : 0.9);
  const marginV = Math.round(H * (1 - baseline));
  const font = hormozi ? 'Arial Black' : 'Arial';
  const maxWords = intensity === 'high' ? 3 : intensity === 'medium' ? 4 : 8;
  const maxChars = vertical ? (hormozi ? 22 : 34) : hormozi ? 32 : 48;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,${font},${fontSize},${WHITE},${WHITE},&H00000000&,&H96000000&,-1,0,0,0,100,100,${hormozi ? 1 : 0},0,1,${outline},${hormozi ? 3 : 1},2,${Math.round(W * 0.06)},${Math.round(W * 0.06)},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines: string[] = [];
  const chunks = chunkWords(words, maxWords, maxChars);
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    const nextStart = chunks[c + 1]?.[0].start ?? Infinity;
    const chunkEnd = Math.min(chunk[chunk.length - 1].end + 0.25, nextStart);
    const texts = chunk.map((w) => {
      const t = escapeAss(cleanWord(w.word));
      return hormozi ? t.toUpperCase() : t;
    });

    if (!hormozi) {
      lines.push(`Dialogue: 0,${assTime(chunk[0].start)},${assTime(chunkEnd)},Main,,0,0,0,,${texts.join(' ')}`);
      continue;
    }
    // Um evento por palavra ativa: mesma frase, palavra atual colorida e com "pop".
    for (let i = 0; i < chunk.length; i++) {
      const start = chunk[i].start;
      const end = i < chunk.length - 1 ? chunk[i + 1].start : chunkEnd;
      if (end - start < 0.02) continue;
      const pop = intensity === 'high' ? '\\fscx112\\fscy112' : '\\fscx106\\fscy106';
      const body = texts
        .map((t, j) => {
          if (j !== i) return t;
          const color = chunk[j].emphasis ? EMPHASIS : HIGHLIGHT;
          return `{\\c${color}${pop}}${t}{\\c${WHITE}\\fscx100\\fscy100}`;
        })
        .join(' ');
      const fadeIn = i === 0 ? '{\\fad(60,0)}' : '';
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Main,,0,0,0,,${fadeIn}${body}`);
    }
  }
  // Top 5: aviso de abertura + placar no canto superior esquerdo que vai acumulando os momentos já
  // mostrados (#5, depois #5 e #4...). O momento atual fica em amarelo e maior; os anteriores, em branco.
  const cards = [...(opts.rankCards ?? [])].sort((a, b) => a.at - b.at);
  if (cards.length) {
    const titleSize = Math.round(fontSize * 0.95);
    lines.push(
      `Dialogue: 2,${assTime(0)},${assTime(Math.min(2.6, cards[0].end))},Main,,0,0,0,,{\\an8\\pos(${Math.round(W / 2)},${Math.round(H * (vertical ? 0.3 : 0.2))})\\fad(120,200)\\fs${titleSize}\\c${HIGHLIGHT}\\bord${outline + 2}}TOP ${cards.length}{\\c${WHITE}}\\NMELHORES MOMENTOS`,
    );
    const rowSize = Math.round(fontSize * (vertical ? 0.52 : 0.45));
    const rowGap = Math.round(rowSize * 1.35);
    const x = Math.round(W * 0.04);
    const y0 = Math.round(H * (vertical ? 0.05 : 0.06));
    cards.forEach((cur, i) => {
      // Cada trecho redesenha o placar inteiro até o início do próximo (o último fica até o fim)
      const end = cards[i + 1]?.at ?? cur.end;
      for (const shown of cards.slice(0, i + 1)) {
        const label = escapeAss(shown.label || `Momento ${shown.rank}`).toUpperCase().slice(0, 28);
        const now = shown === cur;
        // Linha fixa por posição (#1 em cima, #5 embaixo): o placar cresce de baixo para cima
        const y = y0 + (shown.rank - 1) * rowGap;
        const style = now ? `\\fs${Math.round(rowSize * 1.15)}\\c${HIGHLIGHT}\\bord${outline + 1}` : `\\fs${rowSize}\\c${WHITE}\\bord${outline}\\alpha&H20&`;
        const fade = now ? '\\fad(150,0)' : '';
        lines.push(`Dialogue: 1,${assTime(cur.at)},${assTime(end)},Main,,0,0,0,,{\\an7\\pos(${x},${y})${fade}${style}}#${shown.rank} ${label}`);
      }
    });
  }
  return header + lines.join('\n') + '\n';
}

/** SRT com blocos de até ~42 caracteres por linha (2 linhas). */
export function buildSrt(words: TranscriptWord[]): string {
  const chunks = chunkWords(words, 14, 84, 0.9);
  return (
    chunks
      .map((chunk, i) => {
        const text = chunk.map((w) => cleanWord(w.word)).join(' ');
        return `${i + 1}\n${srtTime(chunk[0].start)} --> ${srtTime(chunk[chunk.length - 1].end)}\n${wrapLines(text, 42)}\n`;
      })
      .join('\n')
  );
}

function wrapLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const words = text.split(' ');
  let best = text;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = `${a}\n${b}`;
    }
  }
  return best;
}

/**
 * Para legendas traduzidas (sem timestamps por palavra): distribui as palavras do texto
 * traduzido proporcionalmente ao tamanho, dentro da janela do segmento original.
 */
export function synthesizeWords(segments: { start: number; end: number; text: string }[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const s of segments) {
    const tokens = s.text.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const total = tokens.reduce((a, t) => a + t.length + 1, 0);
    let t = s.start;
    for (const tok of tokens) {
      const d = ((tok.length + 1) / total) * (s.end - s.start);
      out.push({ start: t, end: t + d, word: tok });
      t += d;
    }
  }
  return out;
}
