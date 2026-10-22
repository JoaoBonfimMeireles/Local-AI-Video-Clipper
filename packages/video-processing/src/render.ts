import fs from 'node:fs';
import path from 'node:path';
import type { HwAccel, OutputFormat } from '@clipper/shared';
import { runFfmpeg, sec } from './ffmpeg';

export type OverlayPosition = 'center' | 'top' | 'bottom' | 'top-left' | 'top-right';

export interface RenderZoom {
  at: number;
  duration: number;
  scale: number;
  focusX: number;
  focusY: number;
}

export interface RenderOverlay {
  file: string;
  at: number;
  duration: number;
  position: OverlayPosition;
  /** Largura do overlay como fração da largura do quadro. */
  scale: number;
  hasAudio?: boolean;
  volume?: number;
}

export interface RenderSfx {
  file: string;
  at: number;
  volume: number;
}

export interface RenderSpec {
  input: string;
  start: number;
  end: number;
  source: { width: number; height: number; fps: number; hasAudio: boolean };
  format: OutputFormat;
  zooms?: RenderZoom[];
  overlays?: RenderOverlay[];
  sfx?: RenderSfx[];
  /** Conteúdo ASS (gravado na pasta de trabalho; evita escapar caminhos no filtergraph). */
  assContent?: string;
  /** Faixa de legenda antiga a desfocar (frações da altura da fonte). */
  removeSubtitleRegion?: { y: number; h: number } | null;
  output: string;
  workDir: string;
  hwAccel?: HwAccel;
  threads?: number;
  signal?: AbortSignal;
  onProgress?: (p: number) => void;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const num = (n: number, d = 3) => {
  if (!Number.isFinite(n)) throw new Error(`Número inválido no filtro: ${n}`);
  return Number(n.toFixed(d)).toString();
};

export function canvasSize(format: OutputFormat, src: { width: number; height: number }): { width: number; height: number } {
  switch (format) {
    case 'vertical_blur':
    case 'vertical_crop':
      return { width: 1080, height: 1920 };
    case 'square':
      return { width: 1080, height: 1080 };
    default: {
      const w = even(Math.min(1920, src.width));
      return { width: w, height: even((src.height * w) / src.width) };
    }
  }
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

function overlayInputArgs(file: string, duration: number): string[] {
  const ext = path.extname(file).toLowerCase();
  const t = sec(duration + 0.1);
  if (IMAGE_EXT.has(ext)) return ['-loop', '1', '-framerate', '30', '-t', t, '-i', file];
  if (ext === '.gif') return ['-ignore_loop', '0', '-t', t, '-i', file];
  return ['-stream_loop', '-1', '-t', t, '-i', file];
}

function overlayXY(pos: OverlayPosition, vertical: boolean): string {
  switch (pos) {
    case 'center':
      return 'x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2';
    case 'bottom':
      return vertical ? 'x=(main_w-overlay_w)/2:y=main_h*0.76' : 'x=(main_w-overlay_w)/2:y=main_h*0.42';
    case 'top-left':
      return 'x=main_w*0.04:y=main_h*0.06';
    case 'top-right':
      return 'x=main_w*0.96-overlay_w:y=main_h*0.06';
    case 'top':
    default:
      return 'x=(main_w-overlay_w)/2:y=main_h*0.07';
  }
}

function quantizeZoom(s: number): number {
  if (s <= 1.15) return 1.12;
  if (s <= 1.28) return 1.22;
  return 1.35;
}

/** Monta os argumentos completos do FFmpeg para um corte. Exportado para testes/debug. */
export function buildRenderArgs(spec: RenderSpec, subsFileName: string | null): { args: string[]; duration: number } {
  const duration = spec.end - spec.start;
  if (!(duration > 0.5)) throw new Error(`Duração de corte inválida: ${duration}`);
  const { width: W, height: H } = canvasSize(spec.format, spec.source);
  const vertical = H > W;
  const fps = Math.min(60, Math.max(15, Math.round(spec.source.fps || 30)));
  const inputs: string[] = ['-ss', sec(spec.start), '-t', sec(duration), '-i', spec.input];
  const f: string[] = [];
  let idx = 1;
  let label = 'src';

  f.push(`[0:v]setpts=PTS-STARTPTS,fps=${fps}[src]`);

  // 1) Legenda antiga: desfoca a faixa detectada
  if (spec.removeSubtitleRegion) {
    const sh = spec.source.height;
    const y = even(spec.removeSubtitleRegion.y * sh);
    const h = Math.min(even(spec.removeSubtitleRegion.h * sh), even(sh - y) - 2);
    if (h > 8) {
      // O raio do boxblur precisa ser < metade da altura do plano de croma (h/2 em yuv420p)
      const radius = Math.max(1, Math.min(20, Math.floor(h / 4) - 1));
      f.push(`[src]split=2[rs0][rs1]`);
      f.push(`[rs1]crop=w=iw:h=${h}:x=0:y=${y},boxblur=luma_radius=${radius}:luma_power=3[rsb]`);
      f.push(`[rs0][rsb]overlay=x=0:y=${y}[srcclean]`);
      label = 'srcclean';
    }
  }

  // 2) Formato de saída
  if (spec.format === 'vertical_blur' || spec.format === 'square') {
    const bw = even(W / 4);
    const bh = even(H / 4);
    f.push(`[${label}]split=2[bga][fga]`);
    f.push(`[bga]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=10:3,scale=${W}:${H},eq=brightness=-0.07:saturation=1.15[bg]`);
    f.push(`[fga]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fg]`);
    f.push(`[bg][fg]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2,setsar=1[base]`);
  } else if (spec.format === 'vertical_crop') {
    f.push(`[${label}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[base]`);
  } else {
    f.push(`[${label}]scale=${W}:${H},setsar=1[base]`);
  }
  label = 'base';

  // 3) Zooms (punch-in): agrupados em até 3 níveis; x/y variam por expressão em cada janela
  const zooms = (spec.zooms ?? []).filter((z) => z.at < duration && z.duration > 0.1);
  const levels = new Map<number, RenderZoom[]>();
  for (const z of zooms) {
    const q = quantizeZoom(z.scale);
    levels.set(q, [...(levels.get(q) ?? []), z]);
  }
  let zi = 0;
  for (const [level, list] of levels) {
    const cw = even(W / level);
    const ch = even(H / level);
    const maxX = W - cw;
    const maxY = H - ch;
    const windows = list.map((z) => {
      const a = Math.max(0, z.at);
      const b = Math.min(duration, z.at + z.duration);
      const x = Math.round(Math.min(maxX, Math.max(0, z.focusX * W - cw / 2)));
      const y = Math.round(Math.min(maxY, Math.max(0, z.focusY * H - ch / 2)));
      return { a, b, x, y };
    });
    const nest = (key: 'x' | 'y', fallback: number) =>
      windows.reduceRight((acc, w) => `if(between(t,${num(w.a)},${num(w.b)}),${w[key]},${acc})`, String(fallback));
    const enable = windows.map((w) => `between(t,${num(w.a)},${num(w.b)})`).join('+');
    f.push(`[${label}]split=2[zm${zi}][zs${zi}]`);
    f.push(`[zs${zi}]crop=w=${cw}:h=${ch}:x='${nest('x', Math.round(maxX / 2))}':y='${nest('y', Math.round(maxY / 2))}',scale=${W}:${H},setsar=1[zz${zi}]`);
    f.push(`[zm${zi}][zz${zi}]overlay=x=0:y=0:enable='${enable}'[zo${zi}]`);
    label = `zo${zi}`;
    zi++;
  }

  // 4) Overlays (memes / imagens)
  const audioInputs: string[] = [];
  const overlays = (spec.overlays ?? []).filter((o) => o.at < duration);
  overlays.forEach((o, i) => {
    const dur = Math.min(o.duration, duration - o.at);
    if (dur < 0.2) return;
    inputs.push(...overlayInputArgs(o.file, dur));
    const k = idx++;
    const ow = even(W * Math.min(1, Math.max(0.1, o.scale)));
    const fadeOut = Math.max(o.at, o.at + dur - 0.15);
    f.push(
      `[${k}:v]scale=${ow}:-2,format=rgba,setpts=PTS-STARTPTS+${num(o.at)}/TB,fade=t=in:st=${num(o.at)}:d=0.12:alpha=1,fade=t=out:st=${num(fadeOut)}:d=0.15:alpha=1[ov${i}]`,
    );
    f.push(`[${label}][ov${i}]overlay=${overlayXY(o.position, vertical)}:enable='between(t,${num(o.at)},${num(o.at + dur)})':eof_action=pass[vo${i}]`);
    label = `vo${i}`;
    if (o.hasAudio) {
      const ms = Math.round(o.at * 1000);
      f.push(`[${k}:a]atrim=0:${num(dur)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${num(o.volume ?? 0.9, 2)},adelay=${ms}:all=1[ova${i}]`);
      audioInputs.push(`[ova${i}]`);
    }
  });

  // 5) Legendas (por último, ficam por cima dos memes)
  if (subsFileName) {
    f.push(`[${label}]subtitles=filename=${subsFileName}[vsub]`);
    label = 'vsub';
  }
  f.push(`[${label}]format=yuv420p[vout]`);

  // 6) Áudio: original + efeitos sonoros
  if (spec.source.hasAudio) {
    f.push(`[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a0]`);
  } else {
    f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${num(duration)}[a0]`);
  }
  (spec.sfx ?? [])
    .filter((s) => s.at < duration - 0.1)
    .forEach((s, i) => {
      inputs.push('-i', s.file);
      const k = idx++;
      const ms = Math.round(s.at * 1000);
      f.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${num(Math.min(2, Math.max(0, s.volume)), 2)},adelay=${ms}:all=1[sx${i}]`);
      audioInputs.push(`[sx${i}]`);
    });
  if (audioInputs.length) {
    f.push(`[a0]${audioInputs.join('')}amix=inputs=${audioInputs.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);
  } else {
    f.push(`[a0]anull[aout]`);
  }

  const threads = String(Math.max(1, Math.min(32, Math.floor(spec.threads ?? 4))));
  const video =
    spec.hwAccel === 'nvenc'
      ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high'];

  const args = [
    '-threads', threads,
    ...inputs,
    '-filter_complex', f.join(';'),
    '-filter_complex_threads', threads,
    '-map', '[vout]', '-map', '[aout]',
    ...video,
    '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', sec(duration),
    '-movflags', '+faststart',
    spec.output,
  ];
  return { args, duration };
}

export async function renderClip(spec: RenderSpec): Promise<void> {
  fs.mkdirSync(spec.workDir, { recursive: true });
  fs.mkdirSync(path.dirname(spec.output), { recursive: true });
  let subsName: string | null = null;
  if (spec.assContent) {
    subsName = 'subs.ass';
    fs.writeFileSync(path.join(spec.workDir, subsName), spec.assContent, 'utf8');
  }
  const { args, duration } = buildRenderArgs(spec, subsName);
  fs.writeFileSync(path.join(spec.workDir, 'ffmpeg-args.json'), JSON.stringify(args, null, 2));
  try {
    await runFfmpeg(args, { cwd: spec.workDir, signal: spec.signal, expectedDuration: duration, onProgress: spec.onProgress });
  } catch (e) {
    // NVENC indisponível/ocupado: tenta de novo em CPU
    if (spec.hwAccel === 'nvenc' && !spec.signal?.aborted) {
      const retry = buildRenderArgs({ ...spec, hwAccel: 'none' }, subsName);
      await runFfmpeg(retry.args, { cwd: spec.workDir, signal: spec.signal, expectedDuration: duration, onProgress: spec.onProgress });
      return;
    }
    throw e;
  }
}

export async function extractThumbnail(video: string, out: string, at = 1): Promise<void> {
  await runFfmpeg(['-ss', sec(at), '-i', video, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', out]);
}
