'use client';
// Prévia AO VIVO da edição manual: toca o vídeo ORIGINAL e desenha num canvas exatamente o enquadramento
// (mesmas regras do renderizador: preencher / inteiro com fundo desfocado / câmera + conteúdo), os zooms, os
// memes e os sons. Também traz o editor de quadros: caixas arrastáveis sobre o quadro original, por trecho.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Scissors, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import type { FrameBox, ManualEdit, ManualFrame } from '@clipper/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
  return { video, t, total, playing, vw: dims.vw, vh: dims.vh, toggle, seek, now: clipTime };
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

function drawRegion(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, box: FrameBox, fit: 'cover' | 'blur', dx: number, dy: number, dw: number, dh: number) {
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  let sx = box.x0 * vw;
  let sy = box.y0 * vh;
  let sw = Math.max(2, (box.x1 - box.x0) * vw);
  let sh = Math.max(2, (box.y1 - box.y0) * vh);
  const cover = () => {
    let cx = sx;
    let cy = sy;
    let cw = sw;
    let ch = sh;
    if (cw / ch > dw / dh) {
      const n = (ch * dw) / dh;
      cx += (cw - n) / 2;
      cw = n;
    } else {
      const n = (cw * dh) / dw;
      cy += (ch - n) / 2;
      ch = n;
    }
    ctx.drawImage(v, cx, cy, cw, ch, dx, dy, dw, dh);
  };
  if (fit === 'cover') return cover();
  // Fundo: a mesma área ampliada e desfocada; frente: a área inteira, centralizada
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.filter = 'blur(10px) brightness(0.93) saturate(1.15)';
  cover();
  ctx.filter = 'none';
  const s = Math.min(dw / sw, dh / sh);
  ctx.drawImage(v, sx, sy, sw, sh, dx + (dw - sw * s) / 2, dy + (dh - sh * s) / 2, sw * s, sh * s);
  ctx.restore();
}

export function drawLayout(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, fr: ManualFrame, cw: number, ch: number) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  if (!v.videoWidth) return;
  if (fr.mode === 'split' && fr.box2) {
    const top = Math.round(ch * clamp(fr.topRatio ?? 0.4, 0.2, 0.8));
    drawRegion(ctx, v, fr.box, 'cover', 0, 0, cw, top);
    drawRegion(ctx, v, fr.box2, fr.fit, 0, top, cw, ch - top);
  } else drawRegion(ctx, v, fr.box, fr.fit, 0, 0, cw, ch);
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
}: {
  player: ClipPlayer;
  frames: ManualFrame[];
  zooms: ManualEdit['zooms'];
  overlays: PreviewOverlay[];
  sfx: { url: string; at: number; volume: number }[];
  W: number;
  H: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const off = useRef<HTMLCanvasElement | null>(null);
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
      drawLayout(o.getContext('2d')!, v, frameAt(frames, t), CW, CH);
      // Zoom (punch-in) por cima do enquadramento, como no render
      const z = zooms.find((zz) => t >= zz.at && t < zz.at + zz.duration);
      if (z) {
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
              el.play().catch(() => undefined);
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

      // Sons: tocam quando o tempo passa pelo instante deles
      if (!v.paused) for (const s of sfx) if (lastT.current < s.at && t >= s.at && t - s.at < 0.5) {
        const a = new Audio(s.url);
        a.volume = clamp(s.volume, 0, 1);
        a.play().catch(() => undefined);
      }
      lastT.current = t;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [player, frames, zooms, overlays, sfx, CW, CH]);

  return (
    <div className="space-y-2">
      <canvas ref={canvas} width={CW} height={CH} className="mx-auto block w-full max-w-[300px] rounded-lg bg-black" onClick={player.toggle} />
      <div className="flex items-center gap-2">
        <Button size="icon" variant="outline" className="size-8 shrink-0" onClick={player.toggle} title={player.playing ? 'Pausar' : 'Tocar'}>
          {player.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <input type="range" min={0} max={player.total} step={0.05} value={player.t} onChange={(e) => player.seek(Number(e.target.value))} className="w-full accent-primary" />
        <span className="w-20 shrink-0 text-right font-mono text-xs">
          {player.t.toFixed(1)}/{player.total.toFixed(1)}s
        </span>
      </div>
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
}: {
  player: ClipPlayer;
  frames: ManualFrame[];
  onChange: (frames: ManualFrame[]) => void;
  W: number;
  H: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const { vw, vh } = player;
  const idx = Math.max(0, frames.findIndex((f) => player.t >= f.at && player.t < f.end));
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
  /** Proporção travada de cada caixa (null = livre, quando mostra inteira com fundo desfocado). */
  const lockFor = (which: 'box' | 'box2', f: ManualFrame): number | null => {
    if (f.mode === 'split') return which === 'box' ? W / (H * (f.topRatio ?? 0.4)) : f.fit === 'cover' ? W / (H * (1 - (f.topRatio ?? 0.4))) : null;
    return f.fit === 'cover' ? W / H : null;
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
    const t = Math.round(player.now() * 10) / 10;
    if (t - fr.at < 0.5 || fr.end - t < 0.5) return;
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
    fr.mode === 'split' ? [{ which: 'box', label: 'Câmera (em cima)', color: '#facc15' }, { which: 'box2', label: 'Conteúdo (embaixo)', color: '#38bdf8' }] : [{ which: 'box', label: 'O que aparece', color: '#facc15' }];

  return (
    <div className="space-y-2">
      {/* Linha do tempo dos enquadramentos */}
      <div className="relative h-7 overflow-hidden rounded-md border bg-muted/40">
        {frames.map((f, i) => (
          <button
            key={i}
            className={cn('absolute inset-y-0 border-r border-background text-[10px]', i === idx ? 'bg-primary/40 font-semibold' : 'bg-primary/10 hover:bg-primary/20')}
            style={{ left: `${(f.at / player.total) * 100}%`, width: `${((f.end - f.at) / player.total) * 100}%` }}
            onClick={() => player.seek(f.at + 0.01)}
            title={`${f.at.toFixed(1)}–${f.end.toFixed(1)}s`}
          >
            {f.mode === 'split' ? '▤' : '▢'} {f.at.toFixed(1)}s
          </button>
        ))}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white" style={{ left: `${(player.t / player.total) * 100}%` }} />
      </div>

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
              {fit === 'cover' ? 'Preencher a tela' : 'Inteiro (fundo desfocado)'}
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
        <label className="flex items-center gap-2 text-xs">
          <span className="w-32 text-muted-foreground">Altura da câmera</span>
          <input type="range" min={0.2} max={0.7} step={0.01} value={top} onChange={(e) => setFrame({ topRatio: Number(e.target.value) }, true)} className="w-full accent-primary" />
          <b className="w-10 font-mono">{Math.round(top * 100)}%</b>
        </label>
      )}

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
              style={{ left: `${b.x0 * 100}%`, top: `${b.y0 * 100}%`, width: `${(b.x1 - b.x0) * 100}%`, height: `${(b.y1 - b.y0) * 100}%`, border: `2px solid ${color}`, boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)' }}
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
