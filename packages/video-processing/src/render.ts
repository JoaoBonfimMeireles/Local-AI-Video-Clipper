import fs from 'node:fs';
import path from 'node:path';
import type { HwAccel, OutputFormat } from '@clipper/shared';
import { insertSoundPauses, type SoundPause } from './pauses';
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
  /** Meme com fundo verde: aplica chroma key (cor detectada em keyColor, 0xRRGGBB). */
  greenScreen?: boolean;
  keyColor?: string | null;
  /** meme = só o som do meme (vídeo silencia); video = meme mudo; both = os dois, vídeo abaixado. */
  audioMode?: 'meme' | 'video' | 'both';
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
  /** Máximo a tocar (s); o fim recebe fade. Padrão 5s. */
  duration?: number;
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
  /** Instantes das emendas entre trechos: um flash rápido marca a transição. */
  flashAt?: number[];
  /**
   * Layout de live (só em formatos verticais): facecam em cima, jogo embaixo. cam = caixa da facecam
   * no quadro original (frações: x0, y0, x1, y1). game = centro horizontal do jogo (0-1).
   */
  split?: { cam: { x0: number; y0: number; x1: number; y1: number }; gameX?: number; camRatio?: number } | null;
  /** Rosto do streamer num círculo no canto superior, por cima do conteúdo (área do rosto no quadro original). */
  bubble?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Efeitos sonoros com o vídeo pausado (congelado) enquanto tocam — não atropelam a fala. */
  pauses?: SoundPause[];
  /** Área do conteúdo no quadro original (ex.: o vídeo assistido num react), sem a facecam nem molduras. */
  content?: { x0: number; y0: number; x1: number; y1: number } | null;
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

/** Posição do meme. O meme inteiro fica SEMPRE dentro do quadro: "bottom" encosta a base do meme perto da
 * borda de baixo (personagem de green screen aparece de corpo inteiro, nunca só o topo da cabeça). */
/**
 * Altura da área da facecam (fração da tela) para a câmera ocupar a LARGURA toda na própria proporção.
 * Fica entre 25% e 55% da altura; fora disso apara as sobras da câmera.
 */
export function splitTopRatio(camPx: { w: number; h: number }, W: number, H: number): number {
  const aspect = camPx.w / Math.max(1, camPx.h);
  return Math.min(0.55, Math.max(0.25, W / aspect / H));
}

function overlayXY(pos: OverlayPosition, _vertical: boolean): string {
  // Entre aspas: as vírgulas do max/min não podem separar opções do filtro
  const inside = (y: string) => `'max(0,min(main_h-overlay_h,${y}))'`;
  switch (pos) {
    case 'center':
      return 'x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2';
    case 'bottom':
      return `x=(main_w-overlay_w)/2:y=${inside('main_h*0.97-overlay_h')}`;
    case 'top-left':
      return `x=main_w*0.04:y=${inside('main_h*0.06')}`;
    case 'top-right':
      return `x=main_w*0.96-overlay_w:y=${inside('main_h*0.06')}`;
    case 'top':
    default:
      return `x=(main_w-overlay_w)/2:y=${inside('main_h*0.07')}`;
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
  const split = spec.split && H > W ? spec.split : null;
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
  for (const raw of (split ? [] : spec.shots ?? []).filter((x) => x.at < duration && x.duration > 0.2)) {
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

  const bubble = !split && spec.bubble ? spec.bubble : null;
  const branches = 1 + (wideShots.length ? 1 : 0) + focusBranches.length + (bubble ? 1 : 0);
  const srcLabels = Array.from({ length: branches }, (_, i) => `s${i}`);
  if (branches > 1) f.push(`[src]split=${branches}${srcLabels.map((l) => `[${l}]`).join('')}`);
  else srcLabels[0] = 'src';
  let next = 0;

  const blurComposite = (input: string, out: string, tag: string, OW = W, OH = H) => {
    const bw = even(OW / 4);
    const bh = even(OH / 4);
    f.push(`[${input}]split=2[bga${tag}][fga${tag}]`);
    f.push(`[bga${tag}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=10:3,scale=${OW}:${OH},eq=brightness=-0.07:saturation=1.15[bg${tag}]`);
    f.push(`[fga${tag}]scale=${OW}:${OH}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fg${tag}]`);
    f.push(`[bg${tag}][fg${tag}]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2,setsar=1[${out}]`);
  };
  const windowsExpr = (list: { at: number; duration: number }[]) =>
    list.map((w) => `between(t,${num(Math.max(0, w.at))},${num(Math.min(duration, w.at + w.duration))})`).join('+');

  const baseIn = srcLabels[next++];
  // Retângulo do conteúdo em pixels da fonte (mesmo mapeamento da facecam)
  const content = spec.content
    ? (() => {
        const x = Math.max(0, Math.round(mapX(spec.content.x0) * srcW));
        const y = Math.max(0, Math.round(mapY(spec.content.y0) * srcH));
        const w = even(Math.min(srcW - x, mapX(spec.content.x1) * srcW - x));
        const h = even(Math.min(srcH - y, mapY(spec.content.y1) * srcH - y));
        return w > 32 && h > 32 ? { x, y, w, h } : null;
      })()
    : null;
  if (split) {
    // Facecam INTEIRA em cima, ocupando toda a largura na proporção da própria câmera (sem faixa vazia, sem cortar
    // o streamer); o conteúdo embaixo, inteiro.
    const cam = split.cam;
    const cx0 = mapX(cam.x0) * srcW;
    const cx1 = mapX(cam.x1) * srcW;
    const cy0 = mapY(cam.y0) * srcH;
    const cy1 = mapY(cam.y1) * srcH;
    const topH = even(H * splitTopRatio({ w: cx1 - cx0, h: cy1 - cy0 }, W, H));
    const botH = H - topH;
    // Recorte SEMPRE dentro da câmera ("cover"): se a proporção não bate com a área, apara só as sobras
    // (laterais da câmera, ou o rodapé — nunca a cabeça)
    const slot = W / topH;
    let cw = cx1 - cx0;
    let ch = cy1 - cy0;
    if (cw / ch > slot) cw = ch * slot;
    else ch = cw / slot;
    cw = even(Math.min(cw, srcW));
    ch = even(Math.min(ch, srcH));
    const camX = Math.round(Math.min(srcW - cw, Math.max(0, (cx0 + cx1) / 2 - cw / 2)));
    const camY = Math.round(Math.min(srcH - ch, Math.max(0, cy0)));
    f.push(`[${baseIn}]split=2[cam0][game0]`);
    f.push(`[cam0]crop=${cw}:${ch}:${camX}:${camY},scale=${W}:${topH},setsar=1[camv]`);
    if (content) {
      // React: o vídeo assistido INTEIRO embaixo, sem pedaço da facecam e sem aproximar demais. Só preenche
      // quando a proporção é quase a mesma; senão mostra inteiro com desfoque nas sobras
      f.push(`[game0]crop=${content.w}:${content.h}:${content.x}:${content.y},setsar=1[gcrop]`);
      const ratio = content.w / content.h / (W / botH);
      if (ratio > 0.93 && ratio < 1.07) f.push(`[gcrop]scale=${W}:${botH}:force_original_aspect_ratio=increase,crop=${W}:${botH},setsar=1[gamev]`);
      else blurComposite('gcrop', 'gamev', 'g', W, botH);
    } else {
      // Sem área de conteúdo detectada: a faixa do quadro que não tem a câmera (ao lado ou abaixo dela), inteira,
      // com desfoque nas sobras — nunca um zoom no meio do conteúdo
      const sideW = Math.max(cx0, srcW - cx1);
      const belowH = srcH - cy1;
      const useSide = sideW * srcH >= belowH * srcW;
      const free = useSide
        ? cx0 >= srcW - cx1
          ? { x: 0, y: 0, w: cx0, h: srcH }
          : { x: cx1, y: 0, w: srcW - cx1, h: srcH }
        : { x: 0, y: cy1, w: srcW, h: belowH };
      f.push(`[game0]crop=${even(free.w)}:${even(free.h)}:${Math.round(free.x)}:${Math.round(free.y)},setsar=1[gcrop]`);
      blurComposite('gcrop', 'gamev', 'g', W, botH);
    }
    f.push(`[camv][gamev]vstack=inputs=2,setsar=1[base]`);
  } else if (baseKind === 'blur' && content) {
    // Só o conteúdo (sem molduras/fundo de overlay da live) centralizado, com fundo desfocado
    f.push(`[${baseIn}]crop=${content.w}:${content.h}:${content.x}:${content.y},setsar=1[ccrop]`);
    blurComposite('ccrop', 'base', 'b');
  } else if (baseKind === 'blur') blurComposite(baseIn, 'base', 'b');
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

  // Flash branco curto nas emendas de trechos (transição típica de clipe)
  const flashes = (spec.flashAt ?? []).filter((t) => t > 0.2 && t < duration - 0.2);
  if (flashes.length) {
    f.push(`[${label}]drawbox=x=0:y=0:w=iw:h=ih:color=white@0.55:t=fill:enable='${flashes.map((t) => `between(t,${num(t - 0.04)},${num(t + 0.1)})`).join('+')}'[flash]`);
    label = 'flash';
  }

  // Com enquadramento por pessoa ativo, punch-ins fortes cortariam cabeças: ficam sutis e altos
  const personFraming = focusBranches.length > 0 || !!split;

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

  // 3b) Rosto do streamer num círculo (modo "só o rosto"): canto superior direito, com aro branco
  if (bubble) {
    const D = even(W * (H > W ? 0.38 : 0.24));
    const ring = Math.max(4, Math.round(D * 0.035));
    const R = D / 2 + ring;
    const bx0 = mapX(bubble.x0) * srcW;
    const bx1 = mapX(bubble.x1) * srcW;
    const by0 = mapY(bubble.y0) * srcH;
    const by1 = mapY(bubble.y1) * srcH;
    const side = even(Math.min(srcW, srcH, Math.max(bx1 - bx0, by1 - by0)));
    const sx = Math.round(Math.min(srcW - side, Math.max(0, (bx0 + bx1) / 2 - side / 2)));
    const sy = Math.round(Math.min(srcH - side, Math.max(0, (by0 + by1) / 2 - side / 2)));
    const margin = Math.round(W * 0.04);
    const ox = W - D - 2 * ring - margin;
    const oy = Math.round(H * 0.04);
    f.push(
      `[${srcLabels[branches - 1]}]crop=${side}:${side}:${sx}:${sy},scale=${D}:${D},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-${D / 2},Y-${D / 2}),${D / 2 - 1}),255,0)'[bub]`,
    );
    f.push(`color=c=white:s=${2 * R}x${2 * R}:d=${num(duration + 1)},format=rgba,geq=r=255:g=255:b=255:a='if(lte(hypot(X-${R},Y-${R}),${R - 1}),255,0)'[ring]`);
    f.push(`[${label}][ring]overlay=x=${ox}:y=${oy}:shortest=1[bring]`);
    f.push(`[bring][bub]overlay=x=${ox + ring}:y=${oy + ring}[bface]`);
    label = 'bface';
  }

  // 4) Overlays (memes / imagens)
  const audioInputs: string[] = [];
  /** Janelas em que um meme com áudio toca: o áudio original abaixa (ducking) para o meme ser ouvido. */
  const duckWindows: { a: number; b: number; level: number }[] = [];
  const overlays = (spec.overlays ?? []).filter((o) => o.at < duration);
  overlays.forEach((o, i) => {
    const dur = Math.min(o.duration, duration - o.at);
    if (dur < 0.2) return;
    inputs.push(...overlayInputArgs(o.file, dur));
    const k = idx++;
    const ow = even(W * Math.min(1, Math.max(0.1, o.scale)));
    // Meme alto (vertical) não pode passar de ~45% da altura: encolhe mantendo a proporção
    const oh = even(H * (vertical ? 0.45 : 0.7));
    const fadeOut = Math.max(o.at, o.at + dur - 0.15);
    // Fundo verde vira transparente; despill tira o reflexo verde das bordas do recorte
    const key = o.keyColor && /^0x[0-9a-fA-F]{6}$/.test(o.keyColor) ? o.keyColor : '0x00FF00';
    const chroma = o.greenScreen ? `format=yuv420p,chromakey=color=${key}:similarity=0.16:blend=0.06,despill=type=green,` : '';
    f.push(
      `[${k}:v]${chroma}scale=${ow}:${oh}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=rgba,setpts=PTS-STARTPTS+${num(o.at)}/TB,fade=t=in:st=${num(o.at)}:d=0.12:alpha=1,fade=t=out:st=${num(fadeOut)}:d=0.15:alpha=1[ov${i}]`,
    );
    f.push(`[${label}][ov${i}]overlay=${overlayXY(o.position, vertical)}:enable='between(t,${num(o.at)},${num(o.at + dur)})':eof_action=pass[vo${i}]`);
    label = `vo${i}`;
    if (o.hasAudio && o.audioMode !== 'video') {
      // "meme": a fala do vídeo silencia; "both": fica a 30% por baixo do som do meme
      duckWindows.push({ a: o.at, b: o.at + dur, level: o.audioMode === 'meme' ? 0 : 0.3 });
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
  let mainAudio = 'a0';
  if (duckWindows.length) {
    // Volume do áudio original por instante: o menor nível entre as janelas ativas (silêncio vence ducking)
    const vol = [...duckWindows].sort((x, y) => y.level - x.level).reduce((acc, w) => `if(between(t,${num(w.a)},${num(w.b)}),${num(w.level, 2)},${acc})`, '1');
    f.push(`[a0]volume=volume='${vol}':eval=frame[a0d]`);
    mainAudio = 'a0d';
  }
  (spec.sfx ?? [])
    .filter((s) => s.at < duration - 0.1)
    .forEach((s, i) => {
      inputs.push('-i', s.file);
      const k = idx++;
      const ms = Math.round(s.at * 1000);
      const sd = Math.min(10, Math.max(0.3, s.duration ?? 5));
      f.push(
        `[${k}:a]atrim=0:${num(sd)},afade=t=out:st=${num(Math.max(0, sd - 0.25))}:d=0.25,aresample=48000,aformat=channel_layouts=stereo,volume=${num(Math.min(2, Math.max(0, s.volume)), 2)},adelay=${ms}:all=1[sx${i}]`,
      );
      audioInputs.push(`[sx${i}]`);
    });
  if (audioInputs.length) {
    f.push(`[${mainAudio}]${audioInputs.join('')}amix=inputs=${audioInputs.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);
  } else {
    f.push(`[${mainAudio}]anull[aout]`);
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
  const pauses = (spec.pauses ?? []).filter((p) => p.at > 0.1);
  if (pauses.length) {
    // 1) corte normal num arquivo intermediário; 2) pausas inseridas no vídeo final
    const base = path.join(spec.workDir, 'before_pauses.mp4');
    await renderClip({ ...spec, pauses: [], output: base, onProgress: (p) => spec.onProgress?.(p * 0.85) });
    const duration = spec.end - spec.start;
    const codec = (hw: string | undefined) =>
      hw === 'nvenc' ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high'];
    try {
      await insertSoundPauses({ input: base, output: spec.output, pauses, duration, videoCodec: codec(spec.hwAccel), signal: spec.signal });
    } catch (e) {
      if (spec.hwAccel !== 'nvenc' || spec.signal?.aborted) throw e;
      await insertSoundPauses({ input: base, output: spec.output, pauses, duration, videoCodec: codec('none'), signal: spec.signal });
    }
    spec.onProgress?.(1);
    return;
  }
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
