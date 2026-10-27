// Capas para o teste A/B de miniaturas do YouTube: 3 quadros fortes do corte, cores saturadas e texto gigante
// com contorno grosso (estilo exagerado). Shorts saem em 1080x1920; vídeos horizontais em 1280x720.
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg, sec } from './ffmpeg';

export interface ThumbnailSpec {
  /** Momento do vídeo final (s). */
  at: number;
  text: string;
}

/** Cores de destaque e cor da linha de baixo, alternando entre as 3 capas. */
const STYLES = [
  { top: '&H00FFFFFF&', bottom: '&H0000E5FF&', outline: '&H00000000&', angle: 4 },
  { top: '&H0000E5FF&', bottom: '&H00FFFFFF&', outline: '&H00000000&', angle: -3 },
  { top: '&H00FFFFFF&', bottom: '&H003A3AFF&', outline: '&H00000000&', angle: 0 },
];

const escapeAss = (t: string) => t.replace(/\\/g, '/').replace(/[{}]/g, '');

/** Quebra o texto em até 3 linhas equilibradas. */
function splitLines(text: string, maxChars: number): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + w).length <= maxChars) lines[lines.length - 1] = last + ' ' + w;
    else lines.push(w);
  }
  return lines.slice(0, 3);
}

function thumbAss(text: string, W: number, H: number, k: number): string {
  const st = STYLES[k % STYLES.length];
  const vertical = H > W;
  const lines = splitLines(text, vertical ? 11 : 16);
  const longest = Math.max(...lines.map((l) => l.length), 4);
  // Arial Black: ~0.62 da altura por caractere; ocupa ~92% da largura
  const fs = Math.round(Math.min((W * 0.92) / (longest * 0.62), H * (vertical ? 0.1 : 0.2)));
  const body = lines.map((l, i) => `{\\c${i === lines.length - 1 && lines.length > 1 ? st.bottom : st.top}}${escapeAss(l)}`).join('\\N');
  const y = Math.round(vertical ? H * 0.3 : H * 0.78);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: T,Arial Black,${fs},${st.top},${st.top},${st.outline},&H80000000&,-1,0,0,0,100,100,0,${st.angle},1,${Math.max(4, Math.round(fs * 0.11))},${Math.round(fs * 0.08)},5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,T,,0,0,0,,{\\an5\\pos(${Math.round(W / 2)},${y})}${body}
`;
}

/**
 * Gera `<base>.thumb1.jpg` … `<base>.thumb3.jpg` a partir do vídeo final. Devolve os nomes dos arquivos gerados
 * (capa que falhar fica de fora).
 */
export async function renderThumbnails(args: {
  video: string;
  base: string;
  duration: number;
  vertical: boolean;
  specs: ThumbnailSpec[];
  signal?: AbortSignal;
}): Promise<string[]> {
  const W = args.vertical ? 1080 : 1280;
  const H = args.vertical ? 1920 : 720;
  const dir = path.dirname(args.base);
  const out: string[] = [];
  for (let k = 0; k < Math.min(3, args.specs.length); k++) {
    const sp = args.specs[k];
    const at = Math.max(0, Math.min(sp.at, args.duration - 0.3));
    const file = `${args.base}.thumb${k + 1}.jpg`;
    const assName = `${path.basename(args.base)}.thumb${k + 1}.ass`;
    fs.writeFileSync(path.join(dir, assName), thumbAss(sp.text, W, H, k), 'utf8');
    try {
      const vf = [
        `scale=${W}:${H}:force_original_aspect_ratio=increase`,
        `crop=${W}:${H}`,
        // Cores estouradas e leve vinheta: chama atenção na grade de miniaturas
        'eq=saturation=1.45:contrast=1.15:brightness=0.03',
        'unsharp=5:5:0.8',
        'vignette=PI/5',
        `subtitles=filename=${assName}`,
      ].join(',');
      await runFfmpeg(['-ss', sec(at), '-i', args.video, '-frames:v', '1', '-vf', vf, '-q:v', '2', path.basename(file)], { cwd: dir, signal: args.signal });
      out.push(path.basename(file));
    } catch (e) {
      if (args.signal?.aborted) throw e;
    } finally {
      fs.rmSync(path.join(dir, assName), { force: true });
    }
  }
  return out;
}

/** Capas padrão quando a IA não sugeriu (plano heurístico): 3 momentos espalhados com o texto da capa/título. */
export function defaultThumbnailSpecs(duration: number, text: string): ThumbnailSpec[] {
  const t = text.trim() || 'VOCÊ PRECISA VER ISSO';
  return [0.2, 0.5, 0.8].map((f) => ({ at: duration * f, text: t }));
}
