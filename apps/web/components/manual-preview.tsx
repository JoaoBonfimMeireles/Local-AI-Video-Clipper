'use client';
// Prévia AO VIVO da edição manual: toca o vídeo ORIGINAL e desenha num canvas exatamente o enquadramento
// (mesmas regras do renderizador: preencher / inteiro com fundo desfocado / câmera + conteúdo), os zooms, os
// memes e os sons. Também traz o editor de quadros: caixas arrastáveis sobre o quadro original, por trecho.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2, Pause, Play, Scissors, Sparkles, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { blockStyle, manualCircle, TEXT_ASCENT, TEXT_ASS_SCALE, TEXT_BOX_PAD, TEXT_FONT, textLines, textSpan, type BlockStyle, type FrameBox, type FrameSide, type ManualEdit, type ManualFrame, type ManualText, type UpscaleModel, UPSCALE_MODELS, upscaleModelLabel } from '@clipper/shared';
import { EnhanceCompare, type EnhanceShot } from '@/components/enhance-compare';
import { Button } from '@/components/ui/button';
import { fileUrl } from '@/lib/client';
import { cn } from '@/lib/utils';
import { SpeedPicker } from '@/components/speed-picker';
import { withSpeed } from '@/lib/playback-speed';

type Segment = ManualEdit['segments'][number];
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------- Player: tempo do corte ↔ tempo do vídeo original ----------------

export interface ClipPlayer {
  video: React.RefObject<HTMLVideoElement | null>;
  t: number;
  total: number;
  playing: boolean;
  vw: number;
  vh: number;
  toggle: () => void;
  seek: (t: number) => void;
  /** Tempo atual do corte (lido na hora, sem esperar o React). */
  now: () => number;
  /** Tempo do corte → segundo no arquivo da prévia (para tirar miniaturas). */
  toSource: (t: number) => number;
}

/** offset = segundo do vídeo original em que o arquivo da prévia começa (cópia leve só da parte usada). */
export function useClipPlayer(segments: Segment[], offset = 0, ready = true): ClipPlayer {
  const video = useRef<HTMLVideoElement | null>(null);
  const segIdx = useRef(0);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dims, setDims] = useState({ vw: 0, vh: 0 });
  const offsets = useMemo(() => {
    let acc = 0;
    return segments.map((s) => {
      const o = acc;
      acc += s.end - s.start;
      return o;
    });
  }, [segments]);
  const total = segments.reduce((a, s) => a + (s.end - s.start), 0);

  const clipTime = useCallback(() => {
    const v = video.current;
    const i = segIdx.current;
    if (!v || !segments[i]) return 0;
    return clamp(offsets[i] + (v.currentTime + offset - segments[i].start), 0, total);
  }, [segments, offsets, total, offset]);

  const seek = useCallback(
    (ct: number) => {
      const v = video.current;
      if (!v || !segments.length) return;
      const tt = clamp(ct, 0, Math.max(0, total - 0.05));
      let i = segments.length - 1;
      for (let k = 0; k < segments.length; k++) if (tt < offsets[k] + (segments[k].end - segments[k].start)) {
        i = k;
        break;
      }
      segIdx.current = i;
      v.currentTime = Math.max(0, segments[i].start - offset + (tt - offsets[i]));
      setT(tt);
    },
    [segments, offsets, total, offset],
  );

  // Laço: avança de um trecho para o próximo e atualiza o tempo mostrado
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const v = video.current;
      const i = segIdx.current;
      if (v && segments[i] && !v.paused) {
        if (v.currentTime + offset >= segments[i].end - 0.03) {
          if (i + 1 < segments.length) {
            segIdx.current = i + 1;
            v.currentTime = Math.max(0, segments[i + 1].start - offset);
          } else {
            v.pause();
            setPlaying(false);
          }
        }
        setT(clipTime());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [segments, clipTime]);

  // Trechos mudaram (editor de tamanho): reposiciona no mesmo tempo do corte
  useEffect(() => {
    if (video.current?.readyState) seek(Math.min(t, total));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const onMeta = () => {
      setDims({ vw: v.videoWidth, vh: v.videoHeight });
      seek(0);
    };
    v.addEventListener('loadedmetadata', onMeta);
    if (v.readyState >= 1) onMeta();
    return () => v.removeEventListener('loadedmetadata', onMeta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (clipTime() >= total - 0.1) seek(0);
      v.play().catch(() => undefined);
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };
  const toSource = useCallback(
    (ct: number) => {
      const tt = clamp(ct, 0, total);
      let i = segments.length - 1;
      for (let k = 0; k < segments.length; k++) if (tt < offsets[k] + (segments[k].end - segments[k].start)) {
        i = k;
        break;
      }
      return segments[i] ? Math.max(0, segments[i].start - offset + (tt - offsets[i])) : 0;
    },
    [segments, offsets, total, offset],
  );
  return { video, t, total, playing, vw: dims.vw, vh: dims.vh, toggle, seek, now: clipTime, toSource };
}

// ---------------- Enquadramento: padrão a partir do que a IA fez ----------------

export interface FramingSource {
  layout?: { cam?: FrameBox | null; content?: FrameBox | null; gameplay?: boolean } | null;
  shots: ManualEdit['shots'];
  format: string;
  W: number;
  H: number;
}

/** Caixa com proporção de pixel R (largura/altura na tela), dentro do quadro, em volta de (cx, cy). */
function boxWithAspect(cx: number, cy: number, w: number, R: number, vw: number, vh: number): FrameBox {
  let bw = clamp(w, 0.05, 1);
  let bh = (bw * vw) / (vh * R);
  if (bh > 1) {
    bh = 1;
    bw = (bh * vh * R) / vw;
  }
  const x0 = clamp(cx - bw / 2, 0, 1 - bw);
  const y0 = clamp(cy - bh / 2, 0, 1 - bh);
  return { x0: r2(x0), y0: r2(y0), x1: r2(x0 + bw), y1: r2(y0 + bh) };
}

/** Recorte "cover" que o renderizador faz da câmera (mesma regra do layout facecam). */
function coverInside(b: FrameBox, R: number, vw: number, vh: number): FrameBox {
  let w = b.x1 - b.x0;
  let h = b.y1 - b.y0;
  if ((w * vw) / (h * vh) > R) w = (h * vh * R) / vw;
  else h = (w * vw) / (vh * R);
  const cx = (b.x0 + b.x1) / 2;
  return { x0: r2(cx - w / 2), y0: r2(b.y0), x1: r2(cx + w / 2), y1: r2(b.y0 + h) };
}

export function defaultFrames(src: FramingSource, total: number, vw: number, vh: number): ManualFrame[] {
  const { W, H } = src;
  const whole: FrameBox = { x0: 0, y0: 0, x1: 1, y1: 1 };
  const cam = src.layout?.cam;
  if (cam && H > W) {
    const aspect = ((cam.x1 - cam.x0) * vw) / ((cam.y1 - cam.y0) * vh);
    const topRatio = r2(clamp(W / aspect / H, 0.25, 0.55));
    const content = src.layout?.content ?? (cam.x0 >= 1 - cam.x1 ? { x0: 0, y0: 0, x1: cam.x0, y1: 1 } : { x0: cam.x1, y0: 0, x1: 1, y1: 1 });
    return [{ at: 0, end: total, mode: 'split', fit: 'blur', box: coverInside(cam, W / (H * topRatio), vw, vh), box2: content, topRatio }];
  }
  if (src.layout?.content) return [{ at: 0, end: total, mode: 'single', fit: 'blur', box: src.layout.content }];
  if (src.shots.length) {
    return src.shots.map((sh) => {
      const end = Math.min(total, sh.at + sh.duration);
      if (sh.type === 'wide') return { at: sh.at, end, mode: 'single', fit: 'blur', box: whole };
      // Mesma janela do renderizador: altura inteira / escala, na proporção da tela
      let w = ((1 / sh.scale) * vh * (W / H)) / vw;
      if (w > 1) w = 1 / sh.scale;
      return { at: sh.at, end, mode: 'single', fit: 'cover', box: boxWithAspect(sh.focusX, sh.focusY, w, W / H, vw, vh) };
    });
  }
  if (src.format === 'vertical_crop') return [{ at: 0, end: total, mode: 'single', fit: 'cover', box: boxWithAspect(0.5, 0.5, 1, W / H, vw, vh) }];
  return [{ at: 0, end: total, mode: 'single', fit: 'blur', box: whole }];
}

export const frameAt = (frames: ManualFrame[], t: number) => frames.find((f) => t >= f.at && t < f.end) ?? frames[frames.length - 1];

// ---------------- Desenho (o mesmo que o FFmpeg faz) ----------------

type Drawable = HTMLVideoElement | HTMLImageElement;
const dimsOf = (el: Drawable) => (el instanceof HTMLVideoElement ? { w: el.videoWidth, h: el.videoHeight } : { w: el.naturalWidth, h: el.naturalHeight });
const MID = { x: 0.5, y: 0.5 };

/** Moldura do conteúdo (borda/cantos) em px do canvas: style + largura do canvas (as frações são da largura da tela). */
type Framed = { style?: BlockStyle | null; cw: number };

function drawRegion(ctx: CanvasRenderingContext2D, v: Drawable, box: FrameBox, fit: 'cover' | 'blur', dx: number, dy: number, dw: number, dh: number, align: { x: number; y: number } = MID, bg?: string | null, framed?: Framed) {
  const { w: vw, h: vh } = dimsOf(v);
  if (!vw || !vh) return;
  const sx = box.x0 * vw;
  const sy = box.y0 * vh;
  const sw = Math.max(2, (box.x1 - box.x0) * vw);
  const sh = Math.max(2, (box.y1 - box.y0) * vh);
  /** Desenha a área preenchendo (x, y, w, h), aparando as sobras do lado escolhido. */
  const cover = (x: number, y: number, w: number, h: number, al: { x: number; y: number }) => {
    let cx = sx;
    let cy = sy;
    let cw = sw;
    let ch = sh;
    if (cw / ch > w / h) {
      const n = (ch * w) / h;
      cx += (cw - n) * al.x;
      cw = n;
    } else {
      const n = (cw * h) / w;
      cy += (ch - n) * al.y;
      ch = n;
    }
    ctx.drawImage(v, cx, cy, cw, ch, x, y, w, h);
  };
  // Onde o conteúdo fica: o bloco todo (preencher) ou inteiro dentro dele, na posição escolhida
  const s = Math.min(dw / sw, dh / sh);
  const fg = fit === 'cover' ? { x: dx, y: dy, w: dw, h: dh } : { x: dx + (dw - sw * s) * align.x, y: dy + (dh - sh * s) * align.y, w: sw * s, h: sh * s };
  const sty = framed ? blockStyle(framed.style, framed.cw, fg.w, fg.h) : null;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  // Fundo (aparece em "Inteiro" e, com cantos arredondados, atrás dos cantos): a cor escolhida ou a área desfocada
  if (fit === 'blur' || sty) {
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(dx, dy, dw, dh);
    } else {
      ctx.filter = 'blur(10px) brightness(0.93) saturate(1.15)';
      cover(dx, dy, dw, dh, MID);
      ctx.filter = 'none';
    }
  }
  // Conteúdo: só ele ganha os cantos arredondados e a borda
  ctx.save();
  if (sty && sty.radius > 0) {
    ctx.beginPath();
    ctx.roundRect(fg.x, fg.y, fg.w, fg.h, sty.radius);
    ctx.clip();
  }
  if (fit === 'cover') cover(fg.x, fg.y, fg.w, fg.h, align);
  else ctx.drawImage(v, sx, sy, sw, sh, fg.x, fg.y, fg.w, fg.h);
  ctx.restore();
  if (sty && sty.border > 0) {
    ctx.beginPath();
    ctx.roundRect(fg.x, fg.y, fg.w, fg.h, sty.radius);
    ctx.roundRect(fg.x + sty.border, fg.y + sty.border, fg.w - 2 * sty.border, fg.h - 2 * sty.border, Math.max(0, sty.radius - sty.border));
    ctx.fillStyle = sty.color;
    ctx.fill('evenodd');
  }
  ctx.restore();
}

const WHOLE: FrameBox = { x0: 0, y0: 0, x1: 1, y1: 1 };
/** Elemento já carregado para um conteúdo ao lado (null = ainda carregando). */
export type SideResolver = (sd: FrameSide, fr: ManualFrame) => Drawable | null;

/** Um bloco: conteúdo principal e, se houver, o outro conteúdo ao lado (mesma divisão do render). */
function drawBlock(ctx: CanvasRenderingContext2D, v: Drawable, box: FrameBox, fit: 'cover' | 'blur', align: { x: number; y: number } | undefined, sd: FrameSide | null | undefined, fr: ManualFrame, getSide: SideResolver | undefined, dx: number, dy: number, dw: number, dh: number, bg?: string | null, framed?: Framed) {
  if (!sd) return drawRegion(ctx, v, box, fit, dx, dy, dw, dh, align ?? MID, bg, framed);
  const sw = Math.round(dw * clamp(sd.width, 0.2, 0.8));
  const mw = dw - sw;
  const mx = sd.side === 'left' ? dx + sw : dx;
  const sx = sd.side === 'left' ? dx : dx + mw;
  drawRegion(ctx, v, box, fit, mx, dy, mw, dh, align ?? MID, bg, framed);
  const el = getSide?.(sd, fr);
  if (el) drawRegion(ctx, el, sd.kind === 'scene' ? (sd.box ?? WHOLE) : WHOLE, sd.fit, sx, dy, sw, dh, sd.align ?? MID, bg);
  else {
    ctx.fillStyle = '#18181b';
    ctx.fillRect(sx, dy, sw, dh);
  }
}

export function drawLayout(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, fr: ManualFrame, cw: number, ch: number, getSide?: SideResolver, bg?: string | null) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  if (!v.videoWidth) return;
  if (fr.mode === 'split' && fr.box2 && fr.camShape === 'circle') {
    // Conteúdo na tela toda e o rosto num círculo com aro branco (mesmas medidas do render)
    drawBlock(ctx, v, fr.box2, fr.fit, fr.alignBottom, fr.sideBottom, fr, getSide, 0, 0, cw, ch, bg);
    const c = manualCircle(fr, cw, ch);
    if (c.ring >= 0.5 * (cw / 1080)) {
      ctx.fillStyle = c.ringColor;
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, c.d / 2 + c.ring, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.save();
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, c.d / 2, 0, Math.PI * 2);
    ctx.clip();
    drawRegion(ctx, v, fr.box, 'cover', c.cx - c.d / 2, c.cy - c.d / 2, c.d, c.d);
    ctx.restore();
  } else if (fr.mode === 'split' && fr.box2) {
    const top = Math.round(ch * clamp(fr.topRatio ?? 0.4, 0.2, 0.8));
    // Bloco de baixo menor: a sobra embaixo fica na cor de fundo (preto se o fundo é desfocado), como no render
    const bot = fr.bottomRatio ? Math.min(ch - top, Math.round(ch * fr.bottomRatio)) : ch - top;
    ctx.fillStyle = bg ?? '#000';
    ctx.fillRect(0, top, cw, ch - top);
    drawBlock(ctx, v, fr.box, fr.fitTop ?? 'cover', fr.alignTop, fr.sideTop, fr, getSide, 0, 0, cw, top, bg, { style: fr.styleTop, cw });
    drawBlock(ctx, v, fr.box2, fr.fit, fr.alignBottom, fr.sideBottom, fr, getSide, 0, top, cw, bot, bg, { style: fr.styleBottom, cw });
  } else drawBlock(ctx, v, fr.box, fr.fit, fr.alignTop, fr.sideTop, fr, getSide, 0, 0, cw, ch, bg);
}

/** Retângulos (px do canvas) de cada linha de um texto, com a caixa e a linha de base (mesmas medidas do ASS). */
function textLayout(ctx: CanvasRenderingContext2D, t: ManualText, cw: number, ch: number) {
  const em = t.size * cw;
  const lineH = em * TEXT_ASS_SCALE;
  const rows = textLines(t.text);
  ctx.font = `900 ${em}px "${TEXT_FONT}", Arial, sans-serif`;
  const top = t.y * ch - (rows.length * lineH) / 2;
  const lines = rows.map((r, i) => {
    const w = ctx.measureText(r).width;
    return { text: r, x: t.x * cw - w / 2, w, top: top + i * lineH, base: top + i * lineH + em * TEXT_ASCENT };
  });
  const pad = em * TEXT_BOX_PAD;
  const maxW = Math.max(0, ...lines.map((l) => l.w));
  return { em, lineH, lines, pad, bounds: { x0: t.x * cw - maxW / 2 - pad, y0: top - pad, x1: t.x * cw + maxW / 2 + pad, y1: top + rows.length * lineH + pad } };
}

/** Desenha um texto como o libass: caixa por linha (BorderStyle 3), depois borda e preenchimento. */
function drawText(ctx: CanvasRenderingContext2D, t: ManualText, cw: number, ch: number) {
  const L = textLayout(ctx, t, cw, ch);
  ctx.save();
  if (t.box) {
    ctx.globalAlpha = clamp(t.boxOpacity, 0, 1);
    ctx.fillStyle = t.boxColor;
    for (const l of L.lines) if (l.text) ctx.fillRect(l.x - L.pad, l.top - L.pad, l.w + 2 * L.pad, L.lineH + 2 * L.pad);
    ctx.globalAlpha = 1;
  }
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const bord = Math.max(0, t.outline) * L.em;
  for (const l of L.lines) {
    if (bord > 0) {
      ctx.strokeStyle = t.outlineColor;
      ctx.lineWidth = bord * 2;
      ctx.strokeText(l.text, l.x, l.base);
    }
    ctx.fillStyle = t.color;
    ctx.fillText(l.text, l.x, l.base);
  }
  ctx.restore();
  return L.bounds;
}

// ---------------- Prévia ao vivo ----------------

export interface PreviewOverlay {
  key: string;
  url: string;
  at: number;
  duration: number;
  position: ManualEdit['overlays'][number]['position'];
  scale: number;
  audioMode: ManualEdit['overlays'][number]['audioMode'];
  video: boolean;
  greenScreen: boolean;
}

export function LivePreview({
  player,
  frames,
  zooms,
  overlays,
  sfx,
  W,
  H,
  sceneUrl,
  texts = [],
  logo,
  background,
  onMoveText,
  onMoveLogo,
}: {
  player: ClipPlayer;
  frames: ManualFrame[];
  zooms: ManualEdit['zooms'];
  overlays: PreviewOverlay[];
  sfx: { url: string; at: number; volume: number }[];
  W: number;
  H: number;
  /** Vídeo original inteiro tocável (para "outra cena" ao lado). */
  sceneUrl?: string | null;
  texts?: ManualText[];
  /** Logo do canal (url para a prévia; centro e altura em frações do quadro). */
  logo?: { url: string; x: number; y: number; size: number } | null;
  /** Cor no lugar do fundo desfocado. */
  background?: string | null;
  /** Arrastar um texto / a logo na prévia (novo centro, frações do quadro). */
  onMoveText?: (i: number, x: number, y: number) => void;
  onMoveLogo?: (x: number, y: number) => void;
}) {
  // Caixas (px do canvas) do que pode ser arrastado, atualizadas a cada quadro desenhado
  const hits = useRef<{ kind: 'text' | 'logo'; i: number; x0: number; y0: number; x1: number; y1: number; cx: number; cy: number }[]>([]);
  const dragItem = useRef<{ kind: 'text' | 'logo'; i: number; px: number; py: number; cx: number; cy: number; moved: boolean } | null>(null);
  const logoEl = useRef<HTMLImageElement | null>(null);
  if (logo && logoEl.current?.dataset.url !== logo.url) {
    const img = new Image();
    img.dataset.url = logo.url;
    img.src = logo.url;
    logoEl.current = img;
  }
  const canvas = useRef<HTMLCanvasElement>(null);
  const off = useRef<HTMLCanvasElement | null>(null);
  // Conteúdos ao lado: um elemento por arquivo, sincronizado com o tempo do corte
  const sideEls = useRef(new Map<string, Drawable>());
  const getSide = useCallback<SideResolver>(
    (sd, fr) => {
      const url = sd.kind === 'scene' ? sceneUrl : sd.file ? fileUrl(sd.file) : null;
      if (!url) return null;
      let el = sideEls.current.get(url);
      if (!el) {
        if (sd.kind === 'image') {
          el = new Image();
          el.src = url;
        } else {
          const vid = document.createElement('video');
          vid.src = url;
          vid.muted = true;
          vid.playsInline = true;
          vid.preload = 'auto';
          el = vid;
        }
        sideEls.current.set(url, el);
      }
      if (el instanceof HTMLVideoElement) {
        const v = player.video.current;
        const want = Math.max(0, (sd.start ?? 0) + (player.now() - fr.at));
        if (Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
        if (v && !v.paused && el.paused) withSpeed(el).play().catch(() => undefined);
        if ((!v || v.paused) && !el.paused) el.pause();
        return el.readyState >= 2 ? el : null;
      }
      return el.complete && el.naturalWidth ? el : null;
    },
    [player, sceneUrl],
  );
  useEffect(() => () => sideEls.current.forEach((el) => el instanceof HTMLVideoElement && el.pause()), []);
  const keyCanvas = useRef<HTMLCanvasElement | null>(null);
  const memeEls = useRef(new Map<string, HTMLVideoElement | HTMLImageElement>());
  const lastT = useRef(0);
  const CW = 360;
  const CH = Math.round((CW * H) / W);

  // Elementos dos memes (criados uma vez por arquivo)
  useEffect(() => {
    for (const o of overlays) {
      if (memeEls.current.has(o.key)) continue;
      if (o.video) {
        const el = document.createElement('video');
        el.src = o.url;
        el.loop = true;
        el.playsInline = true;
        el.preload = 'auto';
        memeEls.current.set(o.key, el);
      } else {
        const el = new Image();
        el.src = o.url;
        memeEls.current.set(o.key, el);
      }
    }
  }, [overlays]);

  useEffect(() => () => memeEls.current.forEach((el) => el instanceof HTMLVideoElement && el.pause()), []);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      const v = player.video.current;
      if (!c || !v || !frames.length) return;
      const ctx = c.getContext('2d')!;
      const t = player.now();
      off.current ??= document.createElement('canvas');
      const o = off.current;
      o.width = CW;
      o.height = CH;
      drawLayout(o.getContext('2d')!, v, frameAt(frames, t), CW, CH, getSide, background);
      // Zoom (punch-in) por cima do enquadramento, como no render; o zoom na câmera vence
      const camZ = zooms.find((zz) => zz.target === 'cam' && t >= zz.at && t < zz.at + zz.duration);
      const z = zooms.find((zz) => zz.target !== 'cam' && t >= zz.at && t < zz.at + zz.duration);
      if (camZ) {
        // A câmera do enquadramento daquele instante na tela toda, aproximada em volta do centro
        const b = frameAt(frames, camZ.at).box;
        const s = clamp(camZ.scale, 1, 3);
        const cx = (b.x0 + b.x1) / 2;
        const cy = (b.y0 + b.y1) / 2;
        const hw = (b.x1 - b.x0) / 2 / s;
        const hh = (b.y1 - b.y0) / 2 / s;
        drawRegion(ctx, v, { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh }, 'cover', 0, 0, CW, CH);
      } else if (z) {
        const zw = CW / z.scale;
        const zh = CH / z.scale;
        const zx = clamp(z.focusX * CW - zw / 2, 0, CW - zw);
        const zy = clamp(z.focusY * CH - zh / 2, 0, CH - zh);
        ctx.drawImage(o, zx, zy, zw, zh, 0, 0, CW, CH);
      } else ctx.drawImage(o, 0, 0);

      // Memes / imagens
      let duck = 1;
      for (const ov of overlays) {
        const el = memeEls.current.get(ov.key);
        const on = t >= ov.at && t < ov.at + ov.duration;
        if (el instanceof HTMLVideoElement) {
          if (on && !v.paused) {
            el.muted = ov.audioMode === 'video';
            if (el.paused) {
              el.currentTime = Math.max(0, t - ov.at);
              withSpeed(el).play().catch(() => undefined);
            }
          } else if (!el.paused) el.pause();
          if (on && !el.muted) duck = Math.min(duck, ov.audioMode === 'meme' ? 0 : 0.3);
        }
        if (!on || !el) continue;
        const ew = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
        const eh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
        if (!ew || !eh) continue;
        const ow = CW * ov.scale;
        const oh = (ow * eh) / ew;
        const x = ov.position === 'top-left' ? CW * 0.04 : ov.position === 'top-right' ? CW * 0.96 - ow : (CW - ow) / 2;
        const yRaw = ov.position === 'center' ? (CH - oh) / 2 : ov.position === 'bottom' ? CH * 0.97 - oh : ov.position === 'top' ? CH * 0.07 : CH * 0.06;
        const y = clamp(yRaw, 0, CH - oh);
        if (ov.greenScreen) {
          // Fundo verde vira transparente (aproximação do chromakey do render)
          keyCanvas.current ??= document.createElement('canvas');
          const k = keyCanvas.current;
          k.width = Math.max(1, Math.round(ow));
          k.height = Math.max(1, Math.round(oh));
          const kc = k.getContext('2d', { willReadFrequently: true })!;
          kc.drawImage(el, 0, 0, k.width, k.height);
          const img = kc.getImageData(0, 0, k.width, k.height);
          const d = img.data;
          for (let p = 0; p < d.length; p += 4) if (d[p + 1] > 90 && d[p + 1] > d[p] * 1.35 && d[p + 1] > d[p + 2] * 1.35) d[p + 3] = 0;
          kc.putImageData(img, 0, 0);
          ctx.drawImage(k, x, y);
        } else ctx.drawImage(el, x, y, ow, oh);
      }
      v.volume = duck;

      // Logo e textos (por cima dos memes, como no render)
      const hs: typeof hits.current = [];
      const lg = logoEl.current;
      if (logo && lg?.complete && lg.naturalWidth) {
        const lh = CH * clamp(logo.size, 0.02, 0.5);
        const lw = (lh * lg.naturalWidth) / lg.naturalHeight;
        const lx = logo.x * CW - lw / 2;
        const ly = logo.y * CH - lh / 2;
        ctx.drawImage(lg, lx, ly, lw, lh);
        hs.push({ kind: 'logo', i: 0, x0: lx, y0: ly, x1: lx + lw, y1: ly + lh, cx: logo.x, cy: logo.y });
      }
      texts.forEach((tx, i) => {
        const sp = textSpan(tx, player.total);
        if (t < sp.at || t >= sp.end || !tx.text.trim()) return;
        const b = drawText(ctx, tx, CW, CH);
        hs.push({ kind: 'text', i, ...b, cx: tx.x, cy: tx.y });
      });
      hits.current = hs;

      // Sons: tocam quando o tempo passa pelo instante deles
      if (!v.paused) for (const s of sfx) if (lastT.current < s.at && t >= s.at && t - s.at < 0.5) {
        const a = withSpeed(new Audio(s.url));
        a.volume = clamp(s.volume, 0, 1);
        a.play().catch(() => undefined);
      }
      lastT.current = t;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [player, frames, zooms, overlays, sfx, CW, CH, getSide, texts, logo, background]);

  // Clique toca/pausa; arrastar um texto ou a logo muda a posição
  const toCanvas = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * CW, y: ((e.clientY - r.top) / r.height) * CH };
  };
  const onDown = (e: React.PointerEvent) => {
    const p = toCanvas(e);
    const h = [...hits.current].reverse().find((b) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1 && (b.kind === 'text' ? onMoveText : onMoveLogo));
    if (!h) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragItem.current = { kind: h.kind, i: h.i, px: p.x, py: p.y, cx: h.cx, cy: h.cy, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragItem.current;
    if (!d) return;
    const p = toCanvas(e);
    if (!d.moved && Math.hypot(p.x - d.px, p.y - d.py) < 3) return;
    d.moved = true;
    const x = r2(clamp(d.cx + (p.x - d.px) / CW, 0, 1));
    const y = r2(clamp(d.cy + (p.y - d.py) / CH, 0, 1));
    if (d.kind === 'text') onMoveText?.(d.i, x, y);
    else onMoveLogo?.(x, y);
  };
  const onUp = () => {
    const d = dragItem.current;
    dragItem.current = null;
    if (!d?.moved) player.toggle();
  };

  return (
    <div className="space-y-2">
      <canvas
        ref={canvas}
        width={CW}
        height={CH}
        className="mx-auto block w-full max-w-[300px] touch-none rounded-lg bg-black"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => (dragItem.current = null)}
      />
      <div className="flex items-center gap-2">
        <Button size="icon" variant="outline" className="size-8 shrink-0" onClick={player.toggle} title={player.playing ? 'Pausar' : 'Tocar'}>
          {player.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <input type="range" min={0} max={player.total} step={0.05} value={player.t} onChange={(e) => player.seek(Number(e.target.value))} className="w-full accent-primary" />
        <span className="w-20 shrink-0 text-right font-mono text-xs">
          {player.t.toFixed(1)}/{player.total.toFixed(1)}s
        </span>
      </div>
      <SpeedPicker />
    </div>
  );
}

// ---------------- Editor de quadros (caixas sobre o quadro original) ----------------

type Drag = { which: 'box' | 'box2'; kind: 'move' | 'resize'; x: number; y: number; start: FrameBox; rect: DOMRect };

export function FramingEditor({
  player,
  frames,
  onChange,
  W,
  H,
  toOriginal,
  onCut,
  background,
  enhancePreview,
}: {
  player: ClipPlayer;
  frames: ManualFrame[];
  onChange: (frames: ManualFrame[]) => void;
  W: number;
  H: number;
  /** Tempo do corte -> segundo do vídeo original (para "outra cena" começar no momento atual). */
  toOriginal?: (t: number) => number;
  /** Apaga o trecho [a, b) do corte (tempo do corte). */
  onCut?: (a: number, b: number) => void;
  /** Cor no lugar do fundo desfocado (só para o nome do botão). */
  background?: string | null;
  /** Prévia do "Melhorar qualidade": um quadro da área no momento atual, antes e depois (caminhos das imagens). */
  enhancePreview?: EnhancePreviewFn;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const { vw, vh } = player;
  // Enquadramento do instante atual (no finalzinho do corte, o último)
  const found = frames.findIndex((f) => player.t >= f.at && player.t < f.end);
  const idx = found >= 0 ? found : player.t >= (frames.at(-1)?.end ?? 0) - 0.01 ? frames.length - 1 : 0;
  const fr = frames[idx];

  // Quadro original (o frame atual inteiro), para posicionar as caixas
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      const v = player.video.current;
      if (!c || !v?.videoWidth) return;
      if (c.width !== 480) {
        c.width = 480;
        c.height = Math.round((480 * v.videoHeight) / v.videoWidth);
      }
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [player]);

  if (!fr || !vw) return <p className="text-xs text-muted-foreground">Carregando o vídeo original…</p>;

  const top = clamp(fr.topRatio ?? 0.4, 0.2, 0.8);
  const circle = fr.mode === 'split' && fr.camShape === 'circle';
  /** Proporção travada de cada caixa (null = livre, quando mostra inteira com fundo desfocado). */
  const lockFor = (which: 'box' | 'box2', f: ManualFrame): number | null => {
    // Com um conteúdo ao lado, o principal fica com o resto da largura do bloco
    const mw = (sd?: FrameSide | null) => W * (1 - (sd ? clamp(sd.width, 0.2, 0.8) : 0));
    if (f.mode === 'split' && f.camShape === 'circle') {
      // Círculo: recorte quadrado no rosto; o conteúdo ocupa a tela toda
      if (which === 'box') return 1;
      return f.fit === 'cover' ? mw(f.sideBottom) / H : null;
    }
    if (f.mode === 'split') {
      if (which === 'box') return (f.fitTop ?? 'cover') === 'cover' ? mw(f.sideTop) / (H * (f.topRatio ?? 0.4)) : null;
      const rest = 1 - (f.topRatio ?? 0.4);
      return f.fit === 'cover' ? mw(f.sideBottom) / (H * Math.min(rest, f.bottomRatio ?? rest)) : null;
    }
    return f.fit === 'cover' ? mw(f.sideTop) / H : null;
  };
  const relock = (f: ManualFrame): ManualFrame => {
    const fix = (b: FrameBox | undefined, R: number | null) => (b && R ? boxWithAspect((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.x1 - b.x0, R, vw, vh) : b);
    return { ...f, box: fix(f.box, lockFor('box', f))!, box2: fix(f.box2, lockFor('box2', f)) };
  };
  const setFrame = (patch: Partial<ManualFrame>, lock = false) => {
    const next = frames.map((f, i) => (i === idx ? (lock ? relock({ ...f, ...patch }) : { ...f, ...patch }) : f));
    onChange(next);
  };

  const onDown = (e: React.PointerEvent, which: 'box' | 'box2', kind: 'move' | 'resize') => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { which, kind, x: e.clientX, y: e.clientY, start: { ...(fr[which] as FrameBox) }, rect: area.current!.getBoundingClientRect() };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / d.rect.width;
    const dy = (e.clientY - d.y) / d.rect.height;
    const b = d.start;
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    let nb: FrameBox;
    if (d.kind === 'move') {
      const x0 = clamp(b.x0 + dx, 0, 1 - w);
      const y0 = clamp(b.y0 + dy, 0, 1 - h);
      nb = { x0, y0, x1: x0 + w, y1: y0 + h };
    } else {
      const R = lockFor(d.which, fr);
      let nw = clamp(w + dx, 0.05, 1 - b.x0);
      let nh = R ? (nw * vw) / (vh * R) : clamp(h + dy, 0.05, 1 - b.y0);
      if (R && b.y0 + nh > 1) {
        nh = 1 - b.y0;
        nw = (nh * vh * R) / vw;
      }
      nb = { x0: b.x0, y0: b.y0, x1: b.x0 + nw, y1: b.y0 + nh };
    }
    setFrame({ [d.which]: { x0: r2(nb.x0), y0: r2(nb.y0), x1: r2(nb.x1), y1: r2(nb.y1) } } as Partial<ManualFrame>);
  };
  const onUp = () => {
    drag.current = null;
  };
  /** Aproximar/afastar = diminuir/aumentar a caixa em volta do centro. */
  const zoomBox = (which: 'box' | 'box2', factor: number) => {
    const b = fr[which];
    if (!b) return;
    const R = lockFor(which, fr);
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const w = (b.x1 - b.x0) * factor;
    const nb = R ? boxWithAspect(cx, cy, w, R, vw, vh) : (() => {
      const h = clamp((b.y1 - b.y0) * factor, 0.05, 1);
      const ww = clamp(w, 0.05, 1);
      const x0 = clamp(cx - ww / 2, 0, 1 - ww);
      const y0 = clamp(cy - h / 2, 0, 1 - h);
      return { x0: r2(x0), y0: r2(y0), x1: r2(x0 + ww), y1: r2(y0 + h) };
    })();
    setFrame({ [which]: nb } as Partial<ManualFrame>);
  };
  const splitHere = () => {
    const t = Math.round(player.now() * 100) / 100;
    if (t - fr.at < 0.2 || fr.end - t < 0.2) return;
    onChange([...frames.slice(0, idx), { ...fr, end: t }, { ...structuredClone(fr), at: t }, ...frames.slice(idx + 1)]);
  };
  const removeHere = () => {
    if (frames.length < 2) return;
    const next = frames.filter((_, i) => i !== idx);
    // O trecho vizinho cobre o tempo que ficou vago
    if (idx > 0) next[idx - 1] = { ...next[idx - 1], end: fr.end };
    else next[0] = { ...next[0], at: fr.at };
    onChange(next);
  };

  const boxes: { which: 'box' | 'box2'; label: string; color: string }[] =
    fr.mode === 'split'
      ? [
          { which: 'box', label: circle ? 'Rosto (círculo)' : 'Câmera (em cima)', color: '#facc15' },
          { which: 'box2', label: circle ? 'Conteúdo (tela toda)' : 'Conteúdo (embaixo)', color: '#38bdf8' },
        ]
      : [{ which: 'box', label: 'O que aparece', color: '#facc15' }];

  return (
    <div className="space-y-2">
      {/* Linha do tempo detalhada: miniaturas, zoom, quadro a quadro e bordas arrastáveis */}
      <FrameTimeline player={player} frames={frames} current={idx} onChange={onChange} onCut={onCut} />

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <div className="flex overflow-hidden rounded-md border">
          {(['single', 'split'] as const).map((m) => (
            <button
              key={m}
              className={cn('px-2 py-1', fr.mode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
              onClick={() =>
                setFrame(m === 'split' ? { mode: 'split', topRatio: fr.topRatio ?? 0.4, box2: fr.box2 ?? { x0: 0.3, y0: 0.2, x1: 0.95, y1: 0.95 } } : { mode: 'single' }, true)
              }
            >
              {m === 'single' ? 'Um quadro' : 'Câmera + conteúdo'}
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded-md border">
          {(['cover', 'blur'] as const).map((fit) => (
            <button key={fit} className={cn('px-2 py-1', fr.fit === fit ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')} onClick={() => setFrame({ fit }, true)}>
              {fit === 'cover' ? 'Preencher a tela' : background ? 'Inteiro (fundo de cor)' : 'Inteiro (fundo desfocado)'}
            </button>
          ))}
        </div>
        <Button size="sm" variant="outline" className="h-7 px-2" onClick={splitHere} title="Cria um novo enquadramento a partir deste momento">
          <Scissors className="size-3.5" /> Novo enquadramento aqui
        </Button>
        {frames.length > 1 && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground hover:text-destructive" onClick={removeHere}>
            <Trash2 className="size-3.5" /> Remover este
          </Button>
        )}
      </div>

      {fr.mode === 'split' && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Câmera:</span>
          <Seg
            value={fr.camShape ?? 'rect'}
            options={[
              ['rect', '▭ Quadrado'],
              ['circle', '◯ Círculo'],
            ]}
            onChange={(camShape) => setFrame(camShape === 'circle' ? { camShape, alignTop: { x: 0.5, y: 0 }, topRatio: 0.4 } : { camShape: undefined, alignTop: undefined }, true)}
          />
          {circle && <span className="text-muted-foreground">o rosto fica num círculo por cima do conteúdo, que ocupa a tela toda</span>}
        </div>
      )}
      {fr.mode === 'split' && (
        <label className="flex items-center gap-2 text-xs">
          <span className="w-32 text-muted-foreground">{circle ? 'Tamanho do círculo' : 'Altura da câmera'}</span>
          <input type="range" min={0.2} max={circle ? 0.8 : 0.7} step={0.01} value={top} onChange={(e) => setFrame({ topRatio: Number(e.target.value) }, true)} className="w-full accent-primary" />
          <b className="w-10 font-mono">{Math.round(top * 100)}%</b>
        </label>
      )}
      {fr.mode === 'split' && !circle && (
        <label className="flex items-center gap-2 text-xs">
          <span className="w-32 text-muted-foreground">Altura do conteúdo</span>
          <input
            type="range"
            min={0.15}
            max={r2(1 - top)}
            step={0.01}
            value={Math.min(1 - top, fr.bottomRatio ?? 1 - top)}
            onChange={(e) => {
              const v = Number(e.target.value);
              setFrame({ bottomRatio: v >= 1 - top - 0.005 ? undefined : v }, true);
            }}
            className="w-full accent-primary"
          />
          <b className="w-10 font-mono">{Math.round(Math.min(1 - top, fr.bottomRatio ?? 1 - top) * 100)}%</b>
        </label>
      )}
      {circle && (
        <div className="space-y-2 rounded-md border p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <AlignPad value={fr.alignTop ?? { x: 0.5, y: 0 }} onChange={(alignTop) => setFrame({ alignTop })} center={{ x: 0.5, y: 0 }} tall />
            <span className="text-muted-foreground">Posição do círculo na tela: arraste o ponto</span>
          </div>
          <StyleControls value={fr.styleTop} onChange={(styleTop) => setFrame({ styleTop })} round={false} label="Aro" fallback={{ border: 0.013, color: '#ffffff', radius: 0 }} />
          {enhancePreview && <EnhanceControls key={`ct${idx}`} value={fr.enhanceTop} onChange={(enhanceTop) => setFrame({ enhanceTop })} box={fr.box} preview={enhancePreview} />}
        </div>
      )}

      <div className={cn('grid gap-2', fr.mode === 'split' && !circle && 'sm:grid-cols-2')}>
        {!circle && <BlockControls
          title={fr.mode === 'split' ? 'Bloco de cima' : 'Tela'}
          fit={fr.mode === 'split' ? (fr.fitTop ?? 'cover') : fr.fit}
          onFit={(fit) => setFrame(fr.mode === 'split' ? { fitTop: fit } : { fit }, true)}
          align={fr.alignTop}
          onAlign={(alignTop) => setFrame({ alignTop })}
          side={fr.sideTop}
          onSide={(sideTop) => setFrame({ sideTop }, true)}
          nowOriginal={() => r2(toOriginal?.(player.now()) ?? 0)}
          camBox={fr.box}
          otherBox={fr.box2}
          style={fr.mode === 'split' ? fr.styleTop : undefined}
          onStyle={fr.mode === 'split' ? (styleTop) => setFrame({ styleTop }) : undefined}
          enhance={enhancePreview && <EnhanceControls key={`t${idx}`} value={fr.enhanceTop} onChange={(enhanceTop) => setFrame({ enhanceTop })} box={fr.box} preview={enhancePreview} />}
        />}
        {fr.mode === 'split' && (
          <BlockControls
            title={circle ? 'Conteúdo (tela toda)' : 'Bloco de baixo'}
            fit={fr.fit}
            onFit={(fit) => setFrame({ fit }, true)}
            align={fr.alignBottom}
            onAlign={(alignBottom) => setFrame({ alignBottom })}
            side={fr.sideBottom}
            onSide={(sideBottom) => setFrame({ sideBottom }, true)}
            nowOriginal={() => r2(toOriginal?.(player.now()) ?? 0)}
            camBox={fr.box}
            otherBox={fr.box2}
            style={circle ? undefined : fr.styleBottom}
            onStyle={circle ? undefined : (styleBottom) => setFrame({ styleBottom })}
            enhance={enhancePreview && fr.box2 && <EnhanceControls key={`b${idx}`} value={fr.enhanceBottom} onChange={(enhanceBottom) => setFrame({ enhanceBottom })} box={fr.box2} preview={enhancePreview} />}
          />
        )}
      </div>

      {/* Quadro original com as caixas arrastáveis */}
      <div ref={area} className="relative w-full touch-none select-none overflow-hidden rounded-lg bg-black" style={{ aspectRatio: `${vw} / ${vh}` }} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <canvas ref={canvas} className="absolute inset-0 h-full w-full opacity-80" />
        {boxes.map(({ which, label, color }) => {
          const b = fr[which];
          if (!b) return null;
          return (
            <div
              key={which}
              className="absolute cursor-move"
              style={{ left: `${b.x0 * 100}%`, top: `${b.y0 * 100}%`, width: `${(b.x1 - b.x0) * 100}%`, height: `${(b.y1 - b.y0) * 100}%`, border: `2px solid ${color}`, boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)', borderRadius: circle && which === 'box' ? '50%' : undefined }}
              onPointerDown={(e) => onDown(e, which, 'move')}
            >
              <span className="absolute top-0 left-0 rounded-br px-1 text-[10px] font-semibold text-black" style={{ background: color }}>
                {label}
              </span>
              <span className="absolute top-0.5 right-0.5 flex gap-0.5">
                <button className="rounded bg-black/70 p-0.5 text-white" title="Aproximar (caixa menor)" onPointerDown={(e) => e.stopPropagation()} onClick={() => zoomBox(which, 0.9)}>
                  <ZoomIn className="size-3.5" />
                </button>
                <button className="rounded bg-black/70 p-0.5 text-white" title="Afastar (caixa maior)" onPointerDown={(e) => e.stopPropagation()} onClick={() => zoomBox(which, 1.1)}>
                  <ZoomOut className="size-3.5" />
                </button>
              </span>
              <span className="absolute -right-1.5 -bottom-1.5 size-4 cursor-nwse-resize rounded-sm border-2 border-black" style={{ background: color }} onPointerDown={(e) => onDown(e, which, 'resize')} />
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Arraste a caixa para mudar o que aparece e puxe o canto para aumentar/diminuir (ou use as lupas). Vale para o trecho destacado na linha acima; use <b>Novo enquadramento aqui</b> para mudar só a
        partir de um momento.
      </p>
    </div>
  );
}

// ---------------- Linha do tempo detalhada ----------------

const FPS = 30;

/**
 * Linha do tempo grande para escolher exatamente onde cada enquadramento começa: régua de segundos,
 * miniaturas dos frames, zoom (até ver décimos de segundo), cabeça de leitura arrastável, bordas entre
 * enquadramentos arrastáveis e avanço quadro a quadro (botões ou ← → no teclado; Shift = 1 s; espaço = tocar).
 */
function FrameTimeline({ player, frames, current, onChange, onCut }: { player: ClipPlayer; frames: ManualFrame[]; current: number; onChange: (f: ManualFrame[]) => void; onCut?: (a: number, b: number) => void }) {
  const [zoom, setZoom] = useState(1);
  // Trecho marcado para apagar (tempo do corte); um lado pode estar marcado sem o outro
  const [cut, setCut] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const cutA = cut.a !== null && cut.b !== null ? Math.min(cut.a, cut.b) : null;
  const cutB = cut.a !== null && cut.b !== null ? Math.max(cut.a, cut.b) : null;
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(800);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const drag = useRef<{ kind: 'seek' } | { kind: 'edge'; i: number } | { kind: 'select'; from: number } | null>(null);
  const total = Math.max(0.1, player.total);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Miniaturas: um segundo vídeo (escondido) vai a cada instante e desenha num canvas pequeno
  const thumbCount = Math.min(200, Math.max(10, Math.round(trackW / 90)));
  useEffect(() => {
    const src = player.video.current?.currentSrc || player.video.current?.src;
    if (!src || !player.vw) return;
    let cancelled = false;
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = src;
    const c = document.createElement('canvas');
    c.height = 54;
    c.width = Math.round((54 * player.vw) / player.vh);
    const out: string[] = [];
    (async () => {
      await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
      for (let k = 0; k < thumbCount && !cancelled; k++) {
        v.currentTime = player.toSource(((k + 0.5) / thumbCount) * total);
        await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        out.push(c.toDataURL('image/jpeg', 0.6));
        if (k % 8 === 7 || k === thumbCount - 1) setThumbs([...out]);
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      v.removeAttribute('src');
      v.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.vw, total, thumbCount, player.toSource]);

  // Com zoom, a linha acompanha a cabeça de leitura
  useEffect(() => {
    const sc = scroller.current;
    if (!sc || zoom <= 1) return;
    const x = (player.t / total) * trackW;
    if (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - sc.clientWidth / 2;
  }, [player.t, zoom, total, trackW]);

  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return clamp(((clientX - r.left) / r.width) * total, 0, total);
  };
  const step = (dt: number) => player.seek(Math.round((player.now() + dt) * 1000) / 1000);
  const moveEdge = (i: number, t: number) => {
    // Borda entre o enquadramento i e o i+1 (mínimo 0,2 s para cada lado)
    const a = frames[i];
    const b = frames[i + 1];
    const tt = Math.round(clamp(t, a.at + 0.2, b.end - 0.2) * 100) / 100;
    onChange(frames.map((f, k) => (k === i ? { ...f, end: tt } : k === i + 1 ? { ...f, at: tt } : f)));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      step((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / FPS));
    } else if (e.key === ' ') {
      e.preventDefault();
      player.toggle();
    }
  };

  // Régua: marcas a cada 0,1 / 0,5 / 1 / 5 / 10 s conforme o zoom; rótulos onde cabem
  const pps = trackW / total;
  const tick = pps > 400 ? 0.1 : pps > 120 ? 0.5 : pps > 30 ? 1 : pps > 12 ? 5 : 10;
  const label = pps * tick >= 50 ? tick : pps * tick * 5 >= 50 ? tick * 5 : tick * 10;
  const ticks = Array.from({ length: Math.floor(total / tick) + 1 }, (_, k) => +(k * tick).toFixed(2));
  const pct = (t: number) => `${(t / total) * 100}%`;

  return (
    <div className="space-y-1.5 rounded-lg border p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" tabIndex={0} onKeyDown={onKey}>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <Button size="icon" variant="outline" className="size-7" title="Voltar 1 s (Shift+←)" onClick={() => step(-1)}>
          <ChevronsLeft className="size-4" />
        </Button>
        <Button size="icon" variant="outline" className="size-7" title="Voltar 1 quadro (←)" onClick={() => step(-1 / FPS)}>
          <ChevronLeft className="size-4" />
        </Button>
        <Button size="icon" variant="outline" className="size-7" title={player.playing ? 'Pausar (espaço)' : 'Tocar (espaço)'} onClick={player.toggle}>
          {player.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </Button>
        <Button size="icon" variant="outline" className="size-7" title="Avançar 1 quadro (→)" onClick={() => step(1 / FPS)}>
          <ChevronRight className="size-4" />
        </Button>
        <Button size="icon" variant="outline" className="size-7" title="Avançar 1 s (Shift+→)" onClick={() => step(1)}>
          <ChevronsRight className="size-4" />
        </Button>
        <span className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono">
          {player.t.toFixed(2)}s <span className="text-muted-foreground">/ {total.toFixed(2)}s</span>
        </span>
        <span className="ml-auto flex items-center gap-1 text-muted-foreground">
          <ZoomOut className="size-3.5" />
          <input type="range" min={1} max={20} step={0.5} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="w-28 accent-primary" title="Zoom da linha do tempo" />
          <ZoomIn className="size-3.5" />
          <b className="w-9 font-mono text-foreground">{zoom}x</b>
        </span>
      </div>

      <div ref={scroller} className="overflow-x-auto pb-1">
        <div
          ref={track}
          className="relative h-[104px] cursor-crosshair touch-none select-none"
          style={{ width: `${100 * zoom}%` }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            const t = timeAt(e.clientX);
            // Shift + arrastar marca o trecho a apagar
            if (e.shiftKey && onCut) {
              drag.current = { kind: 'select', from: r2(t) };
              setCut({ a: r2(t), b: r2(t) });
            } else drag.current = { kind: 'seek' };
            player.seek(t);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            if (d.kind === 'seek') player.seek(timeAt(e.clientX));
            else if (d.kind === 'select') {
              const t = timeAt(e.clientX);
              setCut({ a: d.from, b: r2(t) });
              player.seek(t);
            } else moveEdge(d.i, timeAt(e.clientX));
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          {/* Régua */}
          <div className="absolute inset-x-0 top-0 h-5 border-b">
            {ticks.map((t) => {
              const major = Math.abs(t / label - Math.round(t / label)) < 1e-6;
              return (
                <div key={t} className="absolute top-0 h-full" style={{ left: pct(t) }}>
                  <div className={cn('w-px bg-foreground/30', major ? 'h-full' : 'h-1.5')} />
                  {major && <span className="absolute top-0 left-1 font-mono text-[10px] whitespace-nowrap text-muted-foreground">{t % 1 ? t.toFixed(1) : t}s</span>}
                </div>
              );
            })}
          </div>
          {/* Miniaturas dos frames */}
          <div className="absolute inset-x-0 top-5 h-[54px] overflow-hidden bg-black/60">
            {thumbs.map((url, k) => (
              <img key={k} src={url} alt="" draggable={false} className="absolute top-0 h-full object-cover" style={{ left: `${(k / thumbCount) * 100}%`, width: `${100 / thumbCount}%` }} />
            ))}
          </div>
          {/* Enquadramentos */}
          <div className="absolute inset-x-0 top-[78px] h-6">
            {frames.map((f, i) => (
              <div
                key={i}
                className={cn('absolute inset-y-0 overflow-hidden border-r-2 border-background px-1 text-[10px] leading-6 whitespace-nowrap', i === current ? 'bg-primary/60 font-semibold text-primary-foreground' : 'bg-primary/20')}
                style={{ left: pct(f.at), width: pct(f.end - f.at) }}
                title={`${f.at.toFixed(2)}–${f.end.toFixed(2)}s`}
              >
                {f.mode === 'split' ? '▤' : '▢'} {f.at.toFixed(2)}s
              </div>
            ))}
          </div>
          {/* Bordas arrastáveis entre enquadramentos */}
          {frames.slice(0, -1).map((f, i) => (
            <div
              key={`e${i}`}
              className="absolute top-5 bottom-0 z-10 -ml-1.5 w-3 cursor-ew-resize"
              style={{ left: pct(f.end) }}
              title="Arraste para mudar onde este enquadramento troca"
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                drag.current = { kind: 'edge', i };
              }}
            >
              <div className="mx-auto h-full w-1 rounded bg-yellow-400 shadow" />
            </div>
          ))}
          {/* Trecho marcado para apagar (e as marcas soltas de início/fim) */}
          {cutA !== null && cutB !== null && cutB > cutA && (
            <div
              className="pointer-events-none absolute top-5 bottom-0 z-10 border-x-2 border-red-500 bg-red-500/30"
              style={{ left: pct(cutA), width: pct(cutB - cutA), backgroundImage: 'repeating-linear-gradient(45deg, transparent 0 6px, rgba(239,68,68,.45) 6px 12px)' }}
            />
          )}
          {(cutA === null || cutB === null) &&
            [cut.a, cut.b].map((m, k) => (m === null ? null : <div key={k} className="pointer-events-none absolute top-5 bottom-0 z-10 w-0.5 bg-red-500" style={{ left: pct(m) }} />))}
          {/* Cabeça de leitura */}
          <div className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-red-500" style={{ left: pct(player.t) }}>
            <div className="-ml-1.5 size-3.5 rounded-sm bg-red-500" />
          </div>
        </div>
      </div>
      {onCut && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Apagar um trecho:</span>
          <Button size="sm" variant="outline" className="h-7 px-2" title="Marca aqui o começo do trecho a apagar" onClick={() => setCut((c) => ({ ...c, a: r2(player.now()) }))}>
            [ Início aqui
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2" title="Marca aqui o fim do trecho a apagar" onClick={() => setCut((c) => ({ ...c, b: r2(player.now()) }))}>
            Fim aqui ]
          </Button>
          {cutA !== null && cutB !== null && cutB - cutA >= 0.1 && (
            <>
              <span className="font-mono">
                {cutA.toFixed(2)}s → {cutB.toFixed(2)}s ({(cutB - cutA).toFixed(2)}s)
              </span>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 px-2"
                disabled={player.total - (cutB - cutA) < 1}
                onClick={() => {
                  onCut(cutA, cutB);
                  setCut({ a: null, b: null });
                  player.seek(cutA);
                }}
              >
                <Scissors className="size-3.5" /> Apagar trecho
              </Button>
            </>
          )}
          {(cut.a !== null || cut.b !== null) && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground" onClick={() => setCut({ a: null, b: null })}>
              Limpar
            </Button>
          )}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        {onCut && <>Shift + arrastar na linha marca um trecho para apagar · </>}
        Clique ou arraste na linha para ir a um instante · ← → um quadro, Shift+← → um segundo, espaço toca/pausa · arraste as barras amarelas para mudar onde o enquadramento troca · aumente o zoom para
        enxergar quadro a quadro.
      </p>
    </div>
  );
}

// ---------------- Controles de um bloco (encaixe, posição e conteúdo ao lado) ----------------

interface PickList {
  images: { path: string; name: string }[];
  videos: { path: string; name: string }[];
}
let pickCache: Promise<PickList> | null = null;
const joinPath = (dir: string, ...p: string[]) => [dir.replace(/[\\/]+$/, ''), ...p].join(dir.includes('\\') ? '\\' : '/');
/** Imagens/memes da biblioteca e vídeos de data/input (para escolher o conteúdo ao lado). */
function loadPickList(): Promise<PickList> {
  pickCache ??= Promise.all([fetch('/api/library').then((r) => r.json()), fetch('/api/inputs').then((r) => r.json())]).then(([lib, inp]) => {
    const images: PickList['images'] = [];
    for (const kind of ['images', 'memes'] as const)
      for (const c of lib.library[kind] as { name: string; files: string[] }[])
        for (const f of c.files)
          if (/\.(png|jpe?g|webp|gif)$/i.test(f))
            images.push({ path: c.name === '_geral' ? joinPath(lib.dirs[kind], f) : joinPath(lib.dirs[kind], c.name, f), name: `${c.name === '_geral' ? '' : `${c.name}/`}${f}` });
    const videos = (inp.files as { name: string }[]).map((f) => ({ path: joinPath(inp.dir, f.name), name: f.name }));
    return { images, videos };
  });
  pickCache.catch(() => (pickCache = null));
  return pickCache;
}

/**
 * Onde o conteúdo fica dentro do bloco: arraste o ponto (0 = esquerda/topo, 1 = direita/base). Começa no meio;
 * "Centralizar" (ou duplo clique) volta para o ponto inicial.
 */
export function AlignPad({ value, onChange, center = MID, tall = false }: { value?: { x: number; y: number }; onChange: (a: { x: number; y: number }) => void; center?: { x: number; y: number }; tall?: boolean }) {
  const v = value ?? center;
  const pad = useRef<HTMLDivElement>(null);
  const at = (e: React.PointerEvent) => {
    const r = pad.current!.getBoundingClientRect();
    onChange({ x: r2(clamp((e.clientX - r.left) / r.width, 0, 1)), y: r2(clamp((e.clientY - r.top) / r.height, 0, 1)) });
  };
  return (
    <div className="flex items-center gap-1.5">
      <div
        ref={pad}
        className={cn('relative shrink-0 cursor-crosshair touch-none rounded-md border bg-muted/40', tall ? 'h-16 w-9' : 'h-9 w-16')}
        title="Arraste para posicionar o conteúdo no bloco (duplo clique centraliza)"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          at(e);
        }}
        onPointerMove={(e) => e.buttons && at(e)}
        onDoubleClick={() => onChange(center)}
      >
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-foreground/15" />
        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-foreground/15" />
        <div className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow" style={{ left: `${v.x * 100}%`, top: `${v.y * 100}%` }} />
      </div>
      <button type="button" className="rounded border px-1.5 py-0.5 hover:bg-muted" onClick={() => onChange(center)}>
        Centralizar
      </button>
    </div>
  );
}

export type EnhancePreviewFn = (box: FrameBox) => Promise<EnhanceShot>;

/**
 * "Melhorar qualidade" (IA local, grátis) de uma área: compara num quadro do momento atual o original, "só aumentar"
 * e "aumentar + restaurar rostos" no tamanho que o render usa, e escolhe qual vai no vídeo final.
 */
function EnhanceControls({ value, onChange, box, preview }: { value?: UpscaleModel | null; onChange: (m: UpscaleModel | null) => void; box: FrameBox; preview: EnhancePreviewFn }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<EnhanceShot | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setShot(await preview(box));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <b className="flex items-center gap-1">
          <Sparkles className="size-3.5 text-primary" /> Melhorar qualidade (IA local, grátis)
        </b>
        <button type="button" className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-muted disabled:opacity-50" disabled={busy} onClick={run}>
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />} {busy ? 'Gerando as 4 versões… (até 1 min)' : 'Comparar versões neste momento'}
        </button>
        {value && (
          <span className="flex items-center gap-1 font-medium text-primary">
            <Check className="size-3.5" /> no vídeo final: {upscaleModelLabel(value)}
          </span>
        )}
      </div>
      {error && <p className="text-destructive">{error}</p>}
      {shot && <EnhanceCompare shot={shot} value={value ?? null} onPick={onChange} />}
      <div className="flex flex-wrap items-center gap-2">
        <select className="h-7 rounded-md border bg-background px-1" value={value ?? ''} onChange={(e) => onChange((e.target.value || null) as UpscaleModel | null)}>
          <option value="">Não melhorar</option>
          {UPSCALE_MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">
          Vale para esta área neste enquadramento. O render demora mais: uns {value === 'faces' ? '20' : value === 'detailed' ? '40' : value === 'detailedFaces' ? '50' : value === 'fast' ? '3' : '10'} s por segundo de corte (a GPU melhora quadro a quadro).
        </span>
      </div>
    </div>
  );
}

/** Borda (espessura e cor) e cantos arredondados da moldura de um bloco (ou o aro do círculo). */
function StyleControls({ value, onChange, round = true, label = 'Borda', fallback = { border: 0, color: '#ffffff', radius: 0 } }: { value?: BlockStyle | null; onChange: (s: BlockStyle | null) => void; round?: boolean; label?: string; fallback?: BlockStyle }) {
  const st = value ?? fallback;
  const set = (patch: Partial<BlockStyle>) => onChange({ ...st, ...patch });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <label className="flex min-w-40 flex-1 items-center gap-1.5">
        <span className="text-muted-foreground">{label}</span>
        <input type="range" min={0} max={0.03} step={0.001} value={st.border} onChange={(e) => set({ border: Number(e.target.value) })} className="w-full accent-primary" />
        <b className="w-9 font-mono">{st.border ? `${Math.round(st.border * 1080)}px` : 'sem'}</b>
        <input type="color" title={`Cor da ${label.toLowerCase()}`} value={st.color} onChange={(e) => set({ color: e.target.value })} className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent" />
      </label>
      {round && (
        <label className="flex min-w-40 flex-1 items-center gap-1.5">
          <span className="text-muted-foreground">Cantos</span>
          <input type="range" min={0} max={0.12} step={0.002} value={st.radius} onChange={(e) => set({ radius: Number(e.target.value) })} className="w-full accent-primary" />
          <b className="w-9 font-mono">{st.radius ? `${Math.round(st.radius * 1080)}px` : 'retos'}</b>
        </label>
      )}
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex overflow-hidden rounded-md border">
      {options.map(([k, label]) => (
        <button type="button" key={k} className={cn('px-2 py-0.5', value === k ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const sameBox = (a: FrameBox, b: FrameBox) => Math.abs(a.x0 - b.x0) + Math.abs(a.y0 - b.y0) + Math.abs(a.x1 - b.x1) + Math.abs(a.y1 - b.y1) < 0.01;

function BlockControls({
  title,
  fit,
  onFit,
  align,
  onAlign,
  side,
  onSide,
  nowOriginal,
  camBox,
  otherBox,
  style,
  onStyle,
  enhance,
}: {
  title: string;
  fit: 'cover' | 'blur';
  onFit: (f: 'cover' | 'blur') => void;
  align?: { x: number; y: number };
  onAlign: (a: { x: number; y: number }) => void;
  side?: FrameSide | null;
  onSide: (s: FrameSide | null) => void;
  nowOriginal: () => number;
  camBox: FrameBox;
  otherBox?: FrameBox;
  /** Moldura do bloco (só no modo "Câmera + conteúdo"). */
  style?: BlockStyle | null;
  onStyle?: (s: BlockStyle | null) => void;
  /** Controles do "Melhorar qualidade" desta área. */
  enhance?: React.ReactNode;
}) {
  const [list, setList] = useState<PickList | null>(null);
  useEffect(() => {
    if (side && side.kind !== 'scene') loadPickList().then(setList).catch(() => undefined);
  }, [side]);
  const set = (patch: Partial<FrameSide>) => side && onSide({ ...side, ...patch });
  const start = (kind: FrameSide['kind']) => {
    const base = { side: side?.side ?? 'right', width: side?.width ?? 0.5, fit: side?.fit ?? 'cover', align: side?.align } as const;
    if (kind === 'scene') return onSide({ ...base, kind, start: nowOriginal(), box: otherBox ?? camBox });
    onSide({ ...base, kind, start: 0 });
    loadPickList().then((l) => {
      setList(l);
      const first = kind === 'image' ? l.images[0] : l.videos[0];
      if (first) onSide({ ...base, kind, start: 0, file: first.path });
    });
  };
  const boxKey = side?.box && otherBox && sameBox(side.box, otherBox) ? 'content' : side?.box && sameBox(side.box, camBox) ? 'cam' : 'whole';
  return (
    <div className="space-y-2 rounded-md border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <b className="mr-auto">{title}</b>
        <Seg value={fit} options={[['cover', 'Preencher'], ['blur', 'Inteiro']]} onChange={onFit} />
      </div>
      <div className="flex items-center gap-2">
        <AlignPad value={align} onChange={onAlign} />
        <span className="text-muted-foreground">{fit === 'blur' ? 'Posição: arraste o ponto para o lugar exato' : 'Posição (use "Inteiro" para mover o conteúdo; em "Preencher" arraste a caixa)'}</span>
      </div>
      {onStyle && <StyleControls value={style} onChange={onStyle} />}
      {enhance}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Ao lado:</span>
        <Seg
          value={side?.kind ?? 'none'}
          options={[
            ['none', 'Nada'],
            ['image', 'Imagem'],
            ['video', 'Outro vídeo'],
            ['scene', 'Outra cena'],
          ]}
          onChange={(k) => (k === 'none' ? onSide(null) : start(k as FrameSide['kind']))}
        />
      </div>
      {side && (
        <div className="space-y-2 border-l-2 border-primary/40 pl-2">
          {side.kind !== 'scene' && (
            <select className="h-7 w-full rounded-md border bg-background px-1" value={side.file ?? ''} onChange={(e) => set({ file: e.target.value })}>
              {!list && <option value="">Carregando…</option>}
              {list && !(side.kind === 'image' ? list.images : list.videos).length && <option value="">{side.kind === 'image' ? 'Nenhuma imagem na Biblioteca' : 'Nenhum vídeo em data/input'}</option>}
              {(side.kind === 'image' ? list?.images : list?.videos)?.map((i) => (
                <option key={i.path} value={i.path}>
                  {i.name}
                </option>
              ))}
            </select>
          )}
          {side.kind !== 'image' && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Começa em</span>
              <input type="number" min={0} step={0.5} value={side.start ?? 0} onChange={(e) => set({ start: Math.max(0, Number(e.target.value) || 0) })} className="h-7 w-20 rounded-md border bg-background px-1" />
              <span className="text-muted-foreground">s {side.kind === 'scene' ? 'do vídeo original' : 'do vídeo'}</span>
              {side.kind === 'scene' && (
                <button type="button" className="rounded border px-1.5 py-0.5 hover:bg-muted" onClick={() => set({ start: nowOriginal() })} title="Usa o momento em que a prévia está agora">
                  usar o momento atual
                </button>
              )}
            </div>
          )}
          {side.kind === 'scene' && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Área:</span>
              <Seg
                value={boxKey}
                options={[
                  ['cam', 'Câmera'],
                  ['content', 'Conteúdo'],
                  ['whole', 'Tela toda'],
                ]}
                onChange={(k) => set({ box: k === 'cam' ? camBox : k === 'content' ? (otherBox ?? camBox) : { x0: 0, y0: 0, x1: 1, y1: 1 } })}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Seg
              value={side.side}
              options={[
                ['left', '◧ Esquerda'],
                ['right', 'Direita ◨'],
              ]}
              onChange={(v) => set({ side: v })}
            />
            <Seg
              value={side.fit}
              options={[
                ['cover', 'Preencher'],
                ['blur', 'Inteiro'],
              ]}
              onChange={(v) => set({ fit: v })}
            />
            <AlignPad value={side.align} onChange={(a) => set({ align: a })} />
          </div>
          <label className="flex items-center gap-2">
            <span className="w-14 text-muted-foreground">Largura</span>
            <input type="range" min={0.2} max={0.8} step={0.05} value={side.width} onChange={(e) => set({ width: Number(e.target.value) })} className="w-full accent-primary" />
            <b className="w-9 font-mono">{Math.round(side.width * 100)}%</b>
          </label>
        </div>
      )}
    </div>
  );
}
