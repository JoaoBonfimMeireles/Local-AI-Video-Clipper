// Textos do editor manual num ASS só (posições absolutas no quadro de saída). Mesmas medidas da prévia
// (TEXT_* em @clipper/shared): o tamanho do ASS é a altura da linha, a caixa é um BorderStyle 3 por linha.
import { TEXT_ASS_SCALE, TEXT_BOX_PAD, TEXT_FONT, textLines, textSpan, type ManualText } from '@clipper/shared';

const hex = (c: string) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c.slice(1) : 'ffffff');
/** #RRGGBB → &HBBGGRR& (ASS). */
const assColor = (c: string) => {
  const h = hex(c);
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
};
/** Opacidade 0-1 → alfa do ASS (00 = opaco, FF = invisível). */
const assAlpha = (o: number) => `&H${Math.round((1 - Math.min(1, Math.max(0, o))) * 255).toString(16).padStart(2, '0').toUpperCase()}&`;

function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

const escapeAss = (t: string) => t.replace(/\\/g, '/').replace(/[{}]/g, '');

export function buildTextAss(texts: ManualText[], canvas: { width: number; height: number }, duration: number): string | null {
  const { width: W, height: H } = canvas;
  const lines: string[] = [];
  for (const t of texts) {
    const rows = textLines(t.text).map(escapeAss);
    const { at, end } = textSpan(t, duration);
    if (!rows.some(Boolean) || end - at < 0.05) continue;
    const em = t.size * W;
    const fs = Math.round(em * TEXT_ASS_SCALE);
    const pos = `\\an5\\pos(${Math.round(t.x * W)},${Math.round(t.y * H)})\\fs${fs}`;
    const body = rows.join('\\N');
    const span = `${assTime(at)},${assTime(end)}`;
    // Caixa: texto invisível com borda opaca (a borda do BorderStyle 3 é o retângulo de cada linha)
    if (t.box) lines.push(`Dialogue: 0,${span},Box,,0,0,0,,{${pos}\\bord${Math.round(em * TEXT_BOX_PAD)}\\shad0\\1a&HFF&\\3c${assColor(t.boxColor)}\\3a${assAlpha(t.boxOpacity)}}${body}`);
    lines.push(`Dialogue: 1,${span},Text,,0,0,0,,{${pos}\\bord${Math.round(Math.max(0, t.outline) * em * 10) / 10}\\shad0\\c${assColor(t.color)}\\3c${assColor(t.outlineColor)}}${body}`);
  }
  if (!lines.length) return null;
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Text,${TEXT_FONT},100,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1
Style: Box,${TEXT_FONT},100,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join('\n')}
`;
}
