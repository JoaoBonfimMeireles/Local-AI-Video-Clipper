// Medidas do texto sobreposto da edição manual, iguais na prévia (canvas) e no render (ASS/libass).
// Este arquivo não pode importar módulos Node (é usado pela UI).
import type { BlockStyle, ManualFrame, ManualText } from './types';

/** Fonte dos textos. */
export const TEXT_FONT = 'Arial Black';
/** No ASS o tamanho é a altura da linha (ascendente + descendente): em Arial Black, 1,408 x o tamanho da fonte. */
export const TEXT_ASS_SCALE = 1.408;
/** Da linha de cima da linha até a linha de base, em fração do tamanho da fonte. */
export const TEXT_ASCENT = 1.1006;
/** Folga da caixa em volta do texto, em fração do tamanho da fonte. */
export const TEXT_BOX_PAD = 0.25;

export const DEFAULT_MANUAL_TEXT: ManualText = {
  text: 'SEU TEXTO',
  x: 0.5,
  y: 0.15,
  size: 0.07,
  color: '#ffffff',
  outline: 0.08,
  outlineColor: '#000000',
  box: false,
  boxColor: '#000000',
  boxOpacity: 0.7,
};

/** Linhas do texto (só quebras manuais: o render não quebra sozinho). */
export const textLines = (t: string) =>
  t
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, all) => l || (i > 0 && i < all.length - 1));

/** Intervalo em que o texto aparece (sem at/end = o corte inteiro). */
export const textSpan = (t: Pick<ManualText, 'at' | 'end'>, duration: number) => {
  const at = Math.max(0, t.at ?? 0);
  return { at, end: Math.min(duration, t.end ?? duration) };
};

/**
 * Câmera em círculo (enquadramento "Câmera + conteúdo" com camShape = circle): o conteúdo ocupa a tela toda e o
 * rosto fica num círculo com aro branco. Diâmetro = topRatio x largura; posição = alignTop (padrão: em cima, no meio).
 */
export function manualCircle(fr: Pick<ManualFrame, 'topRatio' | 'alignTop' | 'styleTop'>, W: number, H: number) {
  const d = W * Math.min(0.8, Math.max(0.2, fr.topRatio ?? 0.4));
  // Aro: o da moldura de cima (0 = sem aro) ou o padrão, branco
  const ring = fr.styleTop ? Math.max(0, fr.styleTop.border * W) : Math.max(4, d * 0.035);
  const ringColor = fr.styleTop?.color ?? '#ffffff';
  const R = d / 2 + ring;
  const m = W * 0.04;
  const ax = Math.min(1, Math.max(0, fr.alignTop?.x ?? 0.5));
  const ay = Math.min(1, Math.max(0, fr.alignTop?.y ?? 0));
  return { d, ring, ringColor, cx: m + R + (W - 2 * m - 2 * R) * ax, cy: m + R + (H - 2 * m - 2 * R) * ay };
}

/** Moldura de um bloco em px (espessura e raio limitados ao tamanho do bloco); null = sem moldura. */
export function blockStyle(st: BlockStyle | null | undefined, W: number, w: number, h: number) {
  if (!st) return null;
  const border = Math.max(0, Math.min(st.border * W, Math.min(w, h) / 2));
  const radius = Math.max(0, Math.min(st.radius * W, Math.min(w, h) / 2));
  return border > 0.5 || radius > 0.5 ? { border, radius, color: st.color } : null;
}
