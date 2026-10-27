import fs from 'node:fs';
import path from 'node:path';
import { blockStyle, manualCircle, type BlockStyle, type EnhancedArea, type FrameSide, type HwAccel, type ManualFrame, type ManualLogo, type ManualText, type OutputFormat } from '@clipper/shared';
import { insertSoundPauses, type SoundPause } from './pauses';
import { runFfmpeg, sec } from './ffmpeg';
import { buildTextAss } from './text';

export type OverlayPosition = 'center' | 'top' | 'bottom' | 'top-left' | 'top-right';

export interface RenderZoom {
  at: number;
  duration: number;
  scale: number;
  focusX: number;
  focusY: number;
  /** cam = a câmera (caixa de cima do enquadramento) ocupa a tela toda, aproximada em `scale`. */
  target?: 'screen' | 'cam';
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
  /**
   * Conteúdo do react que MUDA ao longo do corte (ex.: o streamer põe o vídeo em tela cheia): em cada janela
   * [at, end) do corte, mostra esta área no lugar de `content`.
   */
  contentPhases?: { at: number; end: number; box: { x0: number; y0: number; x1: number; y1: number } }[] | null;
  /** Rosto do streamer num círculo no canto superior, por cima do conteúdo (área do rosto no quadro original). */
  bubble?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Efeitos sonoros com o vídeo pausado (congelado) enquanto tocam — não atropelam a fala. */
  pauses?: SoundPause[];
  /** Enquadramento manual (editor): substitui shots, facecam, conteúdo e bolha da IA. */
  manualFrames?: ManualFrame[] | null;
  /** Área do conteúdo no quadro original (ex.: o vídeo assistido num react), sem a facecam nem molduras. */
  content?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Cor sólida (#RRGGBB) no lugar do fundo desfocado quando o conteúdo aparece inteiro. */
  fillColor?: string | null;
  /** Textos por cima do vídeo (editor manual). */
  texts?: ManualText[] | null;
  /** Logo do canal durante o corte todo. */
  logo?: ManualLogo | null;
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
export function buildRenderArgs(spec: RenderSpec, subsFileName: string | null, textsFileName: string | null = null): { args: string[]; duration: number } {
  // Enquadramento manual: ignora o da IA (o editor já mostra exatamente o que vai sair)
  const manual = spec.manualFrames?.length ? spec.manualFrames : null;
  if (manual) spec = { ...spec, shots: [], split: null, content: null, contentPhases: null, bubble: null };
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
  // Zoom na câmera: a caixa de cima do enquadramento daquele instante (ou a facecam da IA) na tela toda
  const camAt = (t: number) => {
    if (manual) {
      const fr = [...manual].sort((a, b) => a.at - b.at).find((x) => t >= x.at && t < x.end) ?? manual[manual.length - 1];
      return fr.box;
    }
    return spec.split?.cam ?? spec.bubble ?? null;
  };
  const camZooms = (spec.zooms ?? [])
    .filter((z) => z.target === 'cam' && z.at < duration && z.duration > 0.1)
    .map((z) => ({ z, box: camAt(z.at) }))
    .filter((x): x is { z: RenderZoom; box: { x0: number; y0: number; x1: number; y1: number } } => !!x.box);
  const branches = 1 + (wideShots.length ? 1 : 0) + focusBranches.length + camZooms.length + (bubble ? 1 : 0);
  const srcLabels = Array.from({ length: branches }, (_, i) => `s${i}`);
  if (branches > 1) f.push(`[src]split=${branches}${srcLabels.map((l) => `[${l}]`).join('')}`);
  else srcLabels[0] = 'src';
  let next = 0;

  const fill = spec.fillColor && /^#[0-9a-fA-F]{6}$/.test(spec.fillColor) ? `0x${spec.fillColor.slice(1)}` : null;
  const blurComposite = (input: string, out: string, tag: string, OW = W, OH = H, align = { x: 0.5, y: 0.5 }) => {
    if (fill) {
      // Fundo de cor sólida: o conteúdo inteiro, na posição escolhida, com a cor nas sobras
      f.push(`[${input}]scale=${OW}:${OH}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,pad=${OW}:${OH}:(ow-iw)*${num(align.x, 2)}:(oh-ih)*${num(align.y, 2)}:color=${fill}[${out}]`);
      return;
    }
    const bw = even(OW / 4);
    const bh = even(OH / 4);
    f.push(`[${input}]split=2[bga${tag}][fga${tag}]`);
    f.push(`[bga${tag}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=10:3,scale=${OW}:${OH},eq=brightness=-0.07:saturation=1.15[bg${tag}]`);
    f.push(`[fga${tag}]scale=${OW}:${OH}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fg${tag}]`);
    f.push(`[bg${tag}][fg${tag}]overlay=x=(main_w-overlay_w)*${num(align.x, 2)}:y=(main_h-overlay_h)*${num(align.y, 2)},setsar=1[${out}]`);
  };
  const windowsExpr = (list: { at: number; duration: number }[]) =>
    list.map((w) => `between(t,${num(Math.max(0, w.at))},${num(Math.min(duration, w.at + w.duration))})`).join('+');

  const baseIn = srcLabels[next++];
  // Retângulo do conteúdo em pixels da fonte (mesmo mapeamento da facecam)
  const pxBox = (b: { x0: number; y0: number; x1: number; y1: number }) => {
    const x = Math.max(0, Math.round(mapX(b.x0) * srcW));
    const y = Math.max(0, Math.round(mapY(b.y0) * srcH));
    const w = even(Math.min(srcW - x, mapX(b.x1) * srcW - x));
    const h = even(Math.min(srcH - y, mapY(b.y1) * srcH - y));
    return w > 32 && h > 32 ? { x, y, w, h } : null;
  };
  const content = spec.content ? pxBox(spec.content) : null;
  // Fases em que o conteúdo muda de lugar/tamanho (quadradinho ↔ tela cheia)
  const phases = (spec.contentPhases ?? [])
    .filter((ph) => ph.at < duration && ph.end > ph.at + 0.5)
    .map((ph) => ({ at: Math.max(0, ph.at), end: Math.min(duration, ph.end), px: pxBox(ph.box) }))
    .filter((ph): ph is { at: number; end: number; px: { x: number; y: number; w: number; h: number } } => !!ph.px);
  /** Encaixa um retângulo da fonte numa área OW x OH: preenche se a proporção bate; senão inteiro com desfoque. */
  const fitInto = (input: string, px: { x: number; y: number; w: number; h: number }, OW: number, OH: number, out: string, tag: string) => {
    f.push(`[${input}]crop=${px.w}:${px.h}:${px.x}:${px.y},setsar=1[fc_${tag}]`);
    const ratio = px.w / px.h / (OW / OH);
    if (ratio > 0.93 && ratio < 1.07) f.push(`[fc_${tag}]scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH},setsar=1[${out}]`);
    else blurComposite(`fc_${tag}`, out, tag, OW, OH);
  };
  /** Sobrepõe as fases ao conteúdo principal, cada uma só na sua janela de tempo. Devolve o rótulo final. */
  const overlayPhases = (mainLabel: string, inputs: string[], OW: number, OH: number, tag: string) => {
    let cur = mainLabel;
    phases.forEach((ph, i) => {
      fitInto(inputs[i], ph.px, OW, OH, `${tag}v${i}`, `${tag}${i}`);
      f.push(`[${cur}][${tag}v${i}]overlay=x=0:y=0:enable='between(t,${num(ph.at)},${num(ph.end)})'[${tag}o${i}]`);
      cur = `${tag}o${i}`;
    });
    return cur;
  };
  if (manual) {
    // Um ramo por intervalo; o primeiro é a base e os outros entram por cima só no seu tempo
    const frames = [...manual].sort((a, b) => a.at - b.at);
    const whole = { x: 0, y: 0, w: even(srcW), h: even(srcH) };
    const twoBoxes = (fr: ManualFrame) => fr.mode === 'split' && !!fr.box2;
    const parts = frames.map((fr) => (twoBoxes(fr) ? 2 : 1));
    const total = parts.reduce((a, b) => a + b, 0);
    const ins = Array.from({ length: total }, (_, i) => `mfi${i}`);
    if (total > 1) f.push(`[${baseIn}]split=${total}${ins.map((l) => `[${l}]`).join('')}`);
    else ins[0] = baseIn;
    let k = 0;
    const A = (a?: { x: number; y: number }) => ({ x: Math.min(1, Math.max(0, a?.x ?? 0.5)), y: Math.min(1, Math.max(0, a?.y ?? 0.5)) });
    /** Encaixa [input] (já recortado) em OW x OH: cover = preenche (apara sobras, do lado escolhido); blur = inteira com fundo desfocado. */
    const fitTo = (input: string, fit: ManualFrame['fit'], align: { x: number; y: number }, OW: number, OH: number, out: string, tag: string) => {
      if (fit === 'blur') blurComposite(input, out, `m${tag}`, OW, OH, align);
      else f.push(`[${input}]scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH}:(iw-${OW})*${num(align.x, 2)}:(ih-${OH})*${num(align.y, 2)},setsar=1[${out}]`);
    };
    /** Um quadro parado de w x h na cor dada, repetido o corte todo (o geq que vem depois roda uma vez só). */
    const still = (w: number, h: number, color: string) =>
      `color=c=${/^#[0-9a-fA-F]{6}$/.test(color) ? `0x${color.slice(1)}` : 'white'}:s=${w}x${h}:r=${fps},trim=end_frame=1,format=rgba`;
    const loopStill = `loop=loop=-1:size=1,setpts=N/(${fps}*TB),trim=duration=${num(duration + 0.5)}`;
    /** Distância com sinal até um retângulo arredondado w x h de raio r: > 0 fora, < 0 dentro (expressão do geq). */
    const roundedSd = (w: number, h: number, r: number) => {
      const qx = `(abs(X-${num(w / 2)})-${num(w / 2 - r)})`;
      const qy = `(abs(Y-${num(h / 2)})-${num(h / 2 - r)})`;
      return `(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${num(r)})`;
    };
    /**
     * Área da fonte numa região OW x OH. Com moldura (borda/cantos), só o CONTEÚDO ganha cantos arredondados e borda:
     * o fundo do bloco (desfocado ou a cor escolhida) continua inteiro atrás. Mesmas medidas da prévia (drawRegion).
     */
    const place = (input: string, box: ManualFrame['box'], fit: ManualFrame['fit'], align: { x: number; y: number }, OW: number, OH: number, out: string, tag: string, st?: BlockStyle | null, enh?: { label: string; w: number; h: number } | null) => {
      // Área melhorada (Real-ESRGAN): já vem recortada, numa entrada própria; a cópia do original não é usada
      const px = enh ? { x: 0, y: 0, w: enh.w, h: enh.h } : (pxBox(box) ?? whole);
      if (enh) {
        f.push(`[${input}]nullsink`);
        f.push(`[${enh.label}]setsar=1[mc_${tag}]`);
      } else f.push(`[${input}]crop=${px.w}:${px.h}:${px.x}:${px.y},setsar=1[mc_${tag}]`);
      // Tamanho do conteúdo na tela: o bloco todo (preencher) ou inteiro dentro dele
      const k = Math.min(OW / px.w, OH / px.h);
      const fw = fit === 'blur' ? Math.min(OW, even(px.w * k)) : OW;
      const fh = fit === 'blur' ? Math.min(OH, even(px.h * k)) : OH;
      const sty = blockStyle(st, W, fw, fh);
      if (!sty) return fitTo(`mc_${tag}`, fit, align, OW, OH, out, tag);
      const x = Math.round((OW - fw) * align.x);
      const y = Math.round((OH - fh) * align.y);
      f.push(`[mc_${tag}]split=2[mcb_${tag}][mcf_${tag}]`);
      if (fill) f.push(`[mcb_${tag}]scale=${OW}:${OH},setsar=1,drawbox=x=0:y=0:w=iw:h=ih:color=${fill}:t=fill[mbg_${tag}]`);
      else {
        const bw = even(OW / 4);
        const bh = even(OH / 4);
        f.push(`[mcb_${tag}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=10:3,scale=${OW}:${OH},eq=brightness=-0.07:saturation=1.15,setsar=1[mbg_${tag}]`);
      }
      f.push(
        fit === 'blur'
          ? `[mcf_${tag}]scale=${fw}:${fh},setsar=1,format=rgba[mfg_${tag}]`
          : `[mcf_${tag}]scale=${fw}:${fh}:force_original_aspect_ratio=increase,crop=${fw}:${fh}:(iw-${fw})*${num(align.x, 2)}:(ih-${fh})*${num(align.y, 2)},setsar=1,format=rgba[mfg_${tag}]`,
      );
      const sd = roundedSd(fw, fh, sty.radius);
      f.push(`color=c=white:s=${fw}x${fh}:r=${fps},trim=end_frame=1,format=gray,geq=lum='if(gt(${sd},0),0,255)',${loopStill}[mmk_${tag}]`);
      f.push(`[mfg_${tag}][mmk_${tag}]alphamerge[mfa_${tag}]`);
      let cur = `mbg_${tag}`;
      f.push(`[${cur}][mfa_${tag}]overlay=x=${x}:y=${y}[mpl_${tag}]`);
      cur = `mpl_${tag}`;
      if (sty.border > 0.5) {
        f.push(`${still(fw, fh, sty.color)},geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(${sd},${num(-sty.border)},0),255,0)',${loopStill}[mbd_${tag}]`);
        f.push(`[${cur}][mbd_${tag}]overlay=x=${x}:y=${y}[mpb_${tag}]`);
        cur = `mpb_${tag}`;
      }
      f.push(`[${cur}]setsar=1[${out}]`);
    };
    /** Conteúdo ao lado (imagem, vídeo ou outra cena): entrada própria, alinhada ao tempo do enquadramento. */
    const sideInput = (sd: FrameSide, fr: ManualFrame, tag: string): string | null => {
      if (!sd.file) return null;
      const len = Math.max(0.2, Math.min(duration, fr.end) - Math.max(0, fr.at));
      const n = idx++;
      if (sd.kind === 'image') {
        inputs.push('-loop', '1', '-framerate', String(fps), '-t', sec(duration + 0.1), '-i', sd.file);
        f.push(`[${n}:v]fps=${fps},setsar=1[si_${tag}]`);
      } else {
        inputs.push('-ss', sec(Math.max(0, sd.start ?? 0)), '-t', sec(len + 0.2), '-i', sd.file);
        const b = sd.box;
        const crop = b ? `,crop=iw*${num(b.x1 - b.x0)}:ih*${num(b.y1 - b.y0)}:iw*${num(b.x0)}:ih*${num(b.y0)}` : '';
        // Começa no início do enquadramento (antes disso repete o 1º quadro; o trecho só aparece na sua janela)
        f.push(`[${n}:v]setpts=PTS-STARTPTS,fps=${fps}${crop},tpad=start_mode=clone:start_duration=${num(Math.max(0, fr.at))}:stop_mode=clone:stop_duration=${num(duration)},setsar=1[si_${tag}]`);
      }
      return `si_${tag}`;
    };
    /** Um bloco (tela toda ou metade de cima/baixo): o conteúdo principal e, se houver, o outro conteúdo ao lado. */
    /** Entrada da área melhorada, alinhada ao início do enquadramento (antes repete o 1º quadro, depois o último). */
    const enhancedInput = (e: EnhancedArea | undefined, fr: ManualFrame, tag: string) => {
      if (!e || !fs.existsSync(e.file)) return null;
      const n = idx++;
      inputs.push('-i', e.file);
      f.push(`[${n}:v]setpts=PTS-STARTPTS,fps=${fps},tpad=start_mode=clone:start_duration=${num(Math.max(0, fr.at))}:stop_mode=clone:stop_duration=${num(duration)},setsar=1[en_${tag}]`);
      return { label: `en_${tag}`, w: e.w - (e.w % 2), h: e.h - (e.h % 2) };
    };
    const block = (input: string, box: ManualFrame['box'], fit: ManualFrame['fit'], align: { x: number; y: number }, sd: FrameSide | null | undefined, fr: ManualFrame, OW: number, OH: number, out: string, tag: string, st?: BlockStyle | null, e?: EnhancedArea) => {
      const enh = enhancedInput(e, fr, tag);
      const si = sd ? sideInput(sd, fr, tag) : null;
      if (!sd || !si) return place(input, box, fit, align, OW, OH, out, tag, st, enh);
      const sw = even(OW * Math.min(0.8, Math.max(0.2, sd.width)));
      const mw = OW - sw;
      place(input, box, fit, align, mw, OH, `bm_${tag}`, `${tag}m`, st, enh);
      fitTo(si, sd.fit, A(sd.align), sw, OH, `bs_${tag}`, `${tag}s`);
      f.push(sd.side === 'left' ? `[bs_${tag}][bm_${tag}]hstack=inputs=2,setsar=1[${out}]` : `[bm_${tag}][bs_${tag}]hstack=inputs=2,setsar=1[${out}]`);
    };
    frames.forEach((fr, i) => {
      if (twoBoxes(fr) && fr.camShape === 'circle') {
        // Câmera num círculo por cima do conteúdo, que ocupa a tela toda (mesmas medidas de manualCircle)
        block(ins[k++], fr.box2!, fr.fit, A(fr.alignBottom), fr.sideBottom, fr, W, H, `mcc${i}`, `b${i}`, null, fr.enhancedBottom);
        const c = manualCircle(fr, W, H);
        const D = even(c.d);
        const px = pxBox(fr.box) ?? whole;
        const enh = enhancedInput(fr.enhancedTop, fr, `c${i}`);
        if (enh) f.push(`[${ins[k++]}]nullsink`);
        f.push(
          `[${enh ? enh.label : ins[k++]}]${enh ? '' : `crop=${px.w}:${px.h}:${px.x}:${px.y},`}scale=${D}:${D}:force_original_aspect_ratio=increase,crop=${D}:${D},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-${D / 2},Y-${D / 2}),${D / 2 - 1}),255,0)'[mcf${i}]`,
        );
        let under = `mcc${i}`;
        if (c.ring >= 0.5) {
          // Aro na cor escolhida (0 = sem aro)
          const R = Math.round(D / 2 + c.ring);
          f.push(`${still(2 * R, 2 * R, c.ringColor)},geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-${R},Y-${R}),${R - 1}),255,0)',${loopStill}[mring${i}]`);
          f.push(`[mcc${i}][mring${i}]overlay=x=${Math.round(c.cx - R)}:y=${Math.round(c.cy - R)}[mcr${i}]`);
          under = `mcr${i}`;
        }
        f.push(`[${under}][mcf${i}]overlay=x=${Math.round(c.cx - D / 2)}:y=${Math.round(c.cy - D / 2)}[mf${i}]`);
      } else if (twoBoxes(fr)) {
        const topH = even(H * Math.min(0.8, Math.max(0.2, fr.topRatio ?? 0.4)));
        // Bloco de baixo menor que o resto da tela: a sobra fica embaixo, na cor de fundo
        const botH = fr.bottomRatio ? Math.min(H - topH, even(H * fr.bottomRatio)) : H - topH;
        block(ins[k++], fr.box, fr.fitTop ?? 'cover', A(fr.alignTop), fr.sideTop, fr, W, topH, `mt${i}`, `t${i}`, fr.styleTop, fr.enhancedTop);
        block(ins[k++], fr.box2!, fr.fit, A(fr.alignBottom), fr.sideBottom, fr, W, botH, `mb${i}`, `b${i}`, fr.styleBottom, fr.enhancedBottom);
        let bot = `mb${i}`;
        if (botH < H - topH) {
          f.push(`[mb${i}]pad=${W}:${H - topH}:0:0:color=${fill ?? 'black'}[mbp${i}]`);
          bot = `mbp${i}`;
        }
        f.push(`[mt${i}][${bot}]vstack=inputs=2,setsar=1[mf${i}]`);
      } else {
        block(ins[k++], fr.box, fr.fit, A(fr.alignTop), fr.sideTop, fr, W, H, `mf${i}`, `s${i}`, null, fr.enhancedTop);
      }
    });
    let cur = 'mf0';
    frames.slice(1).forEach((fr, j) => {
      const i = j + 1;
      f.push(`[${cur}][mf${i}]overlay=x=0:y=0:enable='between(t,${num(Math.max(0, fr.at))},${num(Math.min(duration, fr.end))})'[mo${i}]`);
      cur = `mo${i}`;
    });
    f.push(`[${cur}]null[base]`);
  } else if (split) {
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
    f.push(`[${baseIn}]split=${2 + phases.length}[cam0][game0]${phases.map((_, i) => `[gp${i}]`).join('')}`);
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
    const gameLabel = overlayPhases('gamev', phases.map((_, i) => `gp${i}`), W, botH, 'gph');
    f.push(`[camv][${gameLabel}]vstack=inputs=2,setsar=1[base]`);
  } else if (baseKind === 'blur' && (content || phases.length)) {
    // Só o conteúdo (sem molduras/fundo de overlay da live) centralizado, com fundo desfocado; fases por cima
    const mainIn = phases.length ? 'bmain' : baseIn;
    if (phases.length) f.push(`[${baseIn}]split=${1 + phases.length}[bmain]${phases.map((_, i) => `[bp${i}]`).join('')}`);
    if (content) {
      f.push(`[${mainIn}]crop=${content.w}:${content.h}:${content.x}:${content.y},setsar=1[ccrop]`);
      blurComposite('ccrop', phases.length ? 'base0' : 'base', 'b');
    } else blurComposite(mainIn, phases.length ? 'base0' : 'base', 'b');
    if (phases.length) {
      const last = overlayPhases('base0', phases.map((_, i) => `bp${i}`), W, H, 'bph');
      f.push(`[${last}]null[base]`);
    }
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
    .filter((z) => z.target !== 'cam' && z.at < duration && z.duration > 0.1)
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

  // 3a) Zoom na câmera: a área da câmera (aproximada em `scale`, em volta do centro) na tela toda
  camZooms.forEach(({ z, box }, i) => {
    const s = Math.min(3, Math.max(1, z.scale));
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    const hw = (box.x1 - box.x0) / 2 / s;
    const hh = (box.y1 - box.y0) / 2 / s;
    const px = pxBox({ x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh }) ?? { x: 0, y: 0, w: even(srcW), h: even(srcH) };
    const a = Math.max(0, z.at);
    const b = Math.min(duration, z.at + z.duration);
    f.push(`[${srcLabels[next++]}]crop=${px.w}:${px.h}:${px.x}:${px.y},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[czv${i}]`);
    f.push(`[${label}][czv${i}]overlay=x=0:y=0:enable='between(t,${num(a)},${num(b)})'[czo${i}]`);
    label = `czo${i}`;
  });

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

  // 4b) Logo do canal (centro e altura em frações do quadro), o corte todo; GIF animado fica em loop
  if (spec.logo && fs.existsSync(spec.logo.file)) {
    inputs.push(...overlayInputArgs(spec.logo.file, duration));
    const k = idx++;
    const lh = even(H * Math.min(0.5, Math.max(0.02, spec.logo.size)));
    f.push(`[${k}:v]fps=${fps},scale=-2:${lh},format=rgba[logo]`);
    f.push(`[${label}][logo]overlay=x=${Math.round(spec.logo.x * W)}-overlay_w/2:y=${Math.round(spec.logo.y * H)}-overlay_h/2:eof_action=repeat[vlogo]`);
    label = 'vlogo';
  }

  // 4c) Textos do editor
  if (textsFileName) {
    f.push(`[${label}]subtitles=filename=${textsFileName}[vtxt]`);
    label = 'vtxt';
  }

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
  let textsName: string | null = null;
  const textAss = spec.texts?.length ? buildTextAss(spec.texts, canvasSize(spec.format, spec.source), spec.end - spec.start) : null;
  if (textAss) {
    textsName = 'texts.ass';
    fs.writeFileSync(path.join(spec.workDir, textsName), textAss, 'utf8');
  }
  const { args, duration } = buildRenderArgs(spec, subsName, textsName);
  fs.writeFileSync(path.join(spec.workDir, 'ffmpeg-args.json'), JSON.stringify(args, null, 2));
  try {
    await runFfmpeg(args, { cwd: spec.workDir, signal: spec.signal, expectedDuration: duration, onProgress: spec.onProgress });
  } catch (e) {
    // NVENC indisponível/ocupado: tenta de novo em CPU
    if (spec.hwAccel === 'nvenc' && !spec.signal?.aborted) {
      const retry = buildRenderArgs({ ...spec, hwAccel: 'none' }, subsName, textsName);
      await runFfmpeg(retry.args, { cwd: spec.workDir, signal: spec.signal, expectedDuration: duration, onProgress: spec.onProgress });
      return;
    }
    throw e;
  }
}

export async function extractThumbnail(video: string, out: string, at = 1): Promise<void> {
  await runFfmpeg(['-ss', sec(at), '-i', video, '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', out]);
}
