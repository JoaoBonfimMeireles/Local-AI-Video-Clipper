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

export interface RenderShot {
  at: number;
  duration: number;
  type: 'focus' | 'wide';
  focusX: number;
  focusY: number;
  scale: number;
  /** Caixa do rosto da pessoa enquadrada (centro e tamanho, frações do quadro original). */
  subject?: { x: number; y: number; w: number; h: number } | null;
  /** Faixa horizontal (frações do original) com todas as pessoas — usada nos planos abertos. */
  group?: { x0: number; x1: number } | null;
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
  /** Enquadramentos (tempos relativos ao corte), aplicados sobre o vídeo original. */
  shots?: RenderShot[];
  /**
   * Área útil do vídeo original (frações da altura). Usada para deixar a legenda antiga FORA do
   * quadro: tudo (fundo, enquadramentos) passa a usar só essa faixa — sem borrões nem artefatos.
   */
  cleanArea?: { y0: number; y1: number } | null;
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

  // Área limpa (sem a legenda antiga): recorta já na entrada; para o formato original mantém a proporção
  let srcW = spec.source.width;
  let srcH = spec.source.height;
  let mapX = (x: number) => x;
  let mapY = (y: number) => y;
  let cleanCrop = '';
  if (spec.cleanArea && spec.cleanArea.y1 - spec.cleanArea.y0 < 0.98) {
    const y0 = even(spec.cleanArea.y0 * srcH);
    const ch = Math.min(even((spec.cleanArea.y1 - spec.cleanArea.y0) * srcH), srcH - y0 - ((srcH - y0) % 2));
    const cw = spec.format === 'original' ? Math.min(srcW, even((ch * srcW) / srcH)) : srcW - (srcW % 2);
    const x0 = even((srcW - cw) / 2);
    cleanCrop = `,crop=${cw}:${ch}:${x0}:${y0}`;
    const fy0 = spec.cleanArea.y0;
    const fh = spec.cleanArea.y1 - spec.cleanArea.y0;
    const fx0 = x0 / srcW;
    const fw = cw / srcW;
    mapY = (y) => Math.min(1, Math.max(0, (y - fy0) / fh));
    mapX = (x) => Math.min(1, Math.max(0, (x - fx0) / fw));
    srcW = cw;
    srcH = ch;
  }
  f.push(`[0:v]setpts=PTS-STARTPTS,fps=${fps}${cleanCrop}[src]`);

  // 1) Formato de saída + enquadramentos (shots).
  // A legenda antiga já foi removida na preparação (prepareClipSource), não aqui.
  const baseKind = spec.format === 'vertical_crop' ? 'crop' : spec.format === 'original' ? 'scale' : 'blur';
  const LEVELS = [1, 1.3, 1.6, 2.0];
  const windowFor = (level: number) => {
    let winH = srcH / level;
    let winW = (winH * W) / H;
    if (winW > srcW) {
      winW = srcW / level;
      winH = (winW * H) / W;
    }
    return { winW: Math.min(even(winW), srcW - (srcW % 2)), winH: Math.min(even(winH), srcH - (srcH % 2)) };
  };

  /**
   * Regra "pessoa inteira": com a caixa do rosto, a janela precisa conter a cabeça com folga em cima
   * e a largura do corpo (~2,6x o rosto). Se a aproximação pedida cortaria a pessoa, ela é reduzida;
   * se nem o enquadramento normal couber, o shot vira plano aberto (quadro inteiro).
   */
  type Placed = RenderShot & { level: number; x: number; y: number };
  const placed: (Placed | (RenderShot & { type: 'wide' }))[] = [];
  for (const raw of (spec.shots ?? []).filter((x) => x.at < duration && x.duration > 0.2)) {
    const sh = { ...raw, focusX: mapX(raw.focusX), focusY: mapY(raw.focusY) };
    if (sh.type === 'wide') {
      placed.push({ ...sh, type: 'wide' });
      continue;
    }
    const subject = raw.subject
      ? { x: mapX(raw.subject.x) * srcW, y: mapY(raw.subject.y) * srcH, w: (raw.subject.w * spec.source.width) , h: raw.subject.h * spec.source.height }
      : null;
    const wanted = LEVELS.reduce((best, l) => (Math.abs(l - sh.scale) < Math.abs(best - sh.scale) ? l : best), 1);
    let done = false;
    // 1ª tentativa: pessoa com ombros (corpo ~2,6x o rosto). 2ª: cabeça e rosto completos com folga
    // (vídeo original já em close). Só se nenhuma couber, abre o plano.
    const attempts = [
      ...LEVELS.filter((l) => l <= wanted).reverse().map((level) => ({ level, bodyFactor: 2.6 })),
      { level: 1, bodyFactor: 1.4 },
    ];
    for (const { level, bodyFactor } of attempts) {
      const { winW, winH } = windowFor(level);
      const maxX = srcW - winW;
      const maxY = srcH - winH;
      if (!subject) {
        placed.push({
          ...sh,
          level,
          x: Math.round(Math.min(maxX, Math.max(0, sh.focusX * srcW - winW / 2))),
          y: Math.round(Math.min(maxY, Math.max(0, sh.focusY * srcH - winH / 2))),
        });
        done = true;
        break;
      }
      const bodyW = subject.w * bodyFactor;
      const headTop = subject.y - subject.h * 0.95;
      const chest = subject.y + subject.h * 1.8;
      if (bodyW > winW || chest - headTop > winH) continue;
      const x = Math.round(Math.min(maxX, Math.max(0, subject.x - winW / 2)));
      // Cabeça no terço superior, sempre com folga acima do cabelo
      const y = Math.round(Math.min(maxY, Math.max(0, Math.min(headTop - winH * 0.06, subject.y - winH * 0.33))));
      // Confere se a pessoa ficou mesmo dentro (as bordas do vídeo podem impedir centralizar)
      if (subject.x - bodyW / 2 < x - 1 || subject.x + bodyW / 2 > x + winW + 1 || headTop < y - 1) continue;
      placed.push({ ...sh, level, x, y });
      done = true;
      break;
    }
    if (!done) placed.push({ ...sh, type: 'wide' });
  }

  const wideShots = baseKind === 'blur' ? [] : placed.filter((x) => x.type === 'wide');
  const focusLevels = new Map<number, Placed[]>();
  for (const sh of placed) {
    if (sh.type !== 'focus' || !('level' in sh)) continue;
    focusLevels.set(sh.level, [...(focusLevels.get(sh.level) ?? []), sh]);
  }
  const focusBranches = [...focusLevels.entries()]
    .map(([level, list]) => ({ level, list, ...windowFor(level) }))
    // Janela do tamanho do quadro inteiro = igual à base; não precisa de ramo
    .filter((b) => !(baseKind === 'scale' && b.winW >= srcW - 2 && b.winH >= srcH - 2));

  const branches = 1 + (wideShots.length ? 1 : 0) + focusBranches.length;
  const srcLabels = Array.from({ length: branches }, (_, i) => `s${i}`);
  if (branches > 1) f.push(`[src]split=${branches}${srcLabels.map((l) => `[${l}]`).join('')}`);
  else srcLabels[0] = 'src';
  let next = 0;

  const blurComposite = (input: string, out: string, tag: string) => {
    const bw = even(W / 4);
    const bh = even(H / 4);
    f.push(`[${input}]split=2[bga${tag}][fga${tag}]`);
    f.push(`[bga${tag}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=10:3,scale=${W}:${H},eq=brightness=-0.07:saturation=1.15[bg${tag}]`);
    f.push(`[fga${tag}]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fg${tag}]`);
    f.push(`[bg${tag}][fg${tag}]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2,setsar=1[${out}]`);
  };
  const windowsExpr = (list: { at: number; duration: number }[]) =>
    list.map((w) => `between(t,${num(Math.max(0, w.at))},${num(Math.min(duration, w.at + w.duration))})`).join('+');

  const baseIn = srcLabels[next++];
  if (baseKind === 'blur') blurComposite(baseIn, 'base', 'b');
  else if (baseKind === 'crop') f.push(`[${baseIn}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[base]`);
  else f.push(`[${baseIn}]scale=${W}:${H},setsar=1[base]`);
  label = 'base';

  if (wideShots.length) {
    // Se todos os planos abertos sabem onde estão as pessoas, recorta só essa faixa (largura fixa, posição por shot)
    let wideIn = srcLabels[next++];
    if (wideShots.every((w) => w.group)) {
      const spans = wideShots.map((w) => ({ a: mapX(w.group!.x0) * srcW, b: mapX(w.group!.x1) * srcW }));
      const rw = Math.min(srcW - (srcW % 2), even(Math.max(srcW * 0.45, ...spans.map((p) => p.b - p.a))));
      if (rw < srcW - 4) {
        const xs = wideShots.map((w, i) => ({ a: Math.max(0, w.at), b: Math.min(duration, w.at + w.duration), x: Math.round(Math.min(srcW - rw, Math.max(0, (spans[i].a + spans[i].b) / 2 - rw / 2))) }));
        const nx = xs.reduceRight((acc, p) => `if(between(t,${num(p.a)},${num(p.b)}),${p.x},${acc})`, String(Math.round((srcW - rw) / 2)));
        f.push(`[${wideIn}]crop=w=${rw}:h=${srcH - (srcH % 2)}:x='${nx}':y=0[wsrc]`);
        wideIn = 'wsrc';
      }
    }
    blurComposite(wideIn, 'wide', 'w');
    f.push(`[${label}][wide]overlay=x=0:y=0:enable='${windowsExpr(wideShots)}'[bw]`);
    label = 'bw';
  }

  focusBranches.forEach((b, i) => {
    const maxX = srcW - b.winW;
    const maxY = srcH - b.winH;
    const pos = b.list.map((sh) => ({ a: Math.max(0, sh.at), b: Math.min(duration, sh.at + sh.duration), x: sh.x, y: sh.y }));
    const nest = (key: 'x' | 'y', fallback: number) => pos.reduceRight((acc, p) => `if(between(t,${num(p.a)},${num(p.b)}),${p[key]},${acc})`, String(fallback));
    f.push(
      `[${srcLabels[next++]}]crop=w=${b.winW}:h=${b.winH}:x='${nest('x', Math.round(maxX / 2))}':y='${nest('y', Math.round(maxY / 2))}',scale=${W}:${H},setsar=1[fc${i}]`,
    );
    f.push(`[${label}][fc${i}]overlay=x=0:y=0:enable='${windowsExpr(b.list)}'[fo${i}]`);
    label = `fo${i}`;
  });

  // Com enquadramento por pessoa ativo, punch-ins fortes cortariam cabeças: ficam sutis e altos
  const personFraming = focusBranches.length > 0;

  // 3) Zooms (punch-in): agrupados em até 3 níveis; x/y variam por expressão em cada janela
  const zooms = (spec.zooms ?? [])
    .filter((z) => z.at < duration && z.duration > 0.1)
    .map((z) => (personFraming ? { ...z, scale: Math.min(z.scale, 1.12), focusY: Math.min(z.focusY, 0.35) } : z));
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
