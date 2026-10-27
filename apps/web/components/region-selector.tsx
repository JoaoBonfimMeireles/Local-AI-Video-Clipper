'use client';
import { useEffect, useRef, useState } from 'react';
import { Circle, Crosshair, Eraser, MonitorPlay, Scissors, Square } from 'lucide-react';
import { formatTimestamp, type FrameBox, type ManualLayout } from '@clipper/shared';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { fileUrl } from '@/lib/client';
import { cn } from '@/lib/utils';
import { SpeedPicker } from '@/components/speed-picker';

type Tool = 'cam-rect' | 'cam-circle' | 'content' | null;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Painel de seleção: assiste o vídeo inteiro, marca o trecho em que a IA deve procurar cortes e desenha por cima do
 * vídeo a câmera do streamer (retângulo ou círculo no rosto) e a área do conteúdo do react.
 */
export function RegionSelector({
  videoName,
  range,
  layout,
  onRange,
  onLayout,
}: {
  videoName: string;
  range: { start: number; end: number } | null;
  layout: ManualLayout | null;
  onRange: (r: { start: number; end: number } | null) => void;
  onLayout: (l: ManualLayout | null) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const [duration, setDuration] = useState(0);
  const [now, setNow] = useState(0);
  const [tool, setTool] = useState<Tool>(null);
  const [draft, setDraft] = useState<FrameBox | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [pendingStart, setPendingStart] = useState<number | null>(range?.start ?? null);
  // Caminho tocável no navegador (lives baixadas em MPEG-TS ganham uma cópia em MP4 só para a prévia)
  const [src, setSrc] = useState<{ path?: string; error?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    fetch(`/api/inputs/preview?name=${encodeURIComponent(videoName)}`)
      .then((r) => r.json())
      .then((d) => alive && setSrc(d.path ? { path: d.path } : { error: d.error ?? 'erro ao abrir o vídeo' }))
      .catch((e) => alive && setSrc({ error: String(e) }));
    return () => {
      alive = false;
    };
  }, [videoName]);

  useEffect(() => {
    setPendingStart(range?.start ?? null);
  }, [range?.start]);

  const cam = layout?.cam ?? null;
  const content = layout?.content ?? null;
  const update = (patch: Partial<ManualLayout>) => {
    const next = { ...(layout ?? {}), ...patch };
    onLayout(next.cam || next.content ? next : null);
  };

  const point = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };
  const boxFrom = (a: { x: number; y: number }, b: { x: number; y: number }, circle: boolean): FrameBox => {
    if (!circle) return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    // Círculo: arrasta do centro para fora; raio igual em pixels (o quadro não é quadrado)
    const r = Math.hypot((b.x - a.x) * aspect, b.y - a.y);
    return { x0: clamp01(a.x - r / aspect), x1: clamp01(a.x + r / aspect), y0: clamp01(a.y - r), y1: clamp01(a.y + r) };
  };

  function down(e: React.PointerEvent) {
    if (!tool) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = point(e);
    setDraft(null);
  }
  function move(e: React.PointerEvent) {
    if (!tool || !start.current) return;
    setDraft(boxFrom(start.current, point(e), tool === 'cam-circle'));
  }
  function up(e: React.PointerEvent) {
    if (!tool || !start.current) return;
    const box = boxFrom(start.current, point(e), tool === 'cam-circle');
    start.current = null;
    setDraft(null);
    if (box.x1 - box.x0 < 0.02 || box.y1 - box.y0 < 0.02) return;
    if (tool === 'content') update({ content: { box, track: content?.track ?? true } });
    else update({ cam: { box, shape: tool === 'cam-circle' ? 'circle' : 'rect', mode: cam?.mode ?? 'fill', track: cam?.track ?? true } });
    setTool(null);
  }

  const markStart = () => {
    const t = video.current?.currentTime ?? 0;
    setPendingStart(t);
    if (range && range.end > t + 5) onRange({ start: t, end: range.end });
  };
  const markEnd = () => {
    const t = video.current?.currentTime ?? 0;
    const s = pendingStart ?? 0;
    if (t - s >= 5) onRange({ start: s, end: t });
  };

  const boxStyle = (b: FrameBox) => ({ left: `${b.x0 * 100}%`, top: `${b.y0 * 100}%`, width: `${(b.x1 - b.x0) * 100}%`, height: `${(b.y1 - b.y0) * 100}%` });

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <div>
        <Label>Painel do vídeo (opcional)</Label>
        <SpeedPicker className="float-right" />
        <p className="mt-1 text-xs text-muted-foreground">
          Assista, marque o trecho em que a IA deve procurar os cortes e, em reacts, desenhe a câmera do streamer e a área do vídeo a que ele reage.
        </p>
      </div>

      <div ref={stage} className="relative mx-auto w-full overflow-hidden rounded-md bg-black" style={{ aspectRatio: String(aspect) }}>
        {!src?.path && (
          <p className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-white/80">
            {src?.error ?? 'Preparando a prévia do vídeo… (lives longas podem levar alguns segundos na primeira vez)'}
          </p>
        )}
        <video
          ref={video}
          src={src?.path ? fileUrl(src.path) : undefined}
          controls={!tool}
          preload="metadata"
          className="absolute inset-0 h-full w-full"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
            setDuration(v.duration || 0);
          }}
          onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
        />
        {/* Camada de desenho: só captura o mouse quando uma ferramenta está ativa (senão os controles do player funcionam) */}
        <div className={cn('absolute inset-0', tool ? 'cursor-crosshair' : 'pointer-events-none')} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
          {cam && (
            <div className={cn('absolute border-2 border-sky-400 bg-sky-400/15', cam.shape === 'circle' && 'rounded-full')} style={boxStyle(cam.box)}>
              <span className="absolute -top-5 left-0 rounded bg-sky-500 px-1 text-[10px] font-medium text-white">Câmera</span>
            </div>
          )}
          {content && (
            <div className="absolute border-2 border-amber-400 bg-amber-400/10" style={boxStyle(content.box)}>
              <span className="absolute -top-5 left-0 rounded bg-amber-500 px-1 text-[10px] font-medium text-black">Conteúdo</span>
            </div>
          )}
          {draft && <div className={cn('absolute border-2 border-dashed border-white', tool === 'cam-circle' && 'rounded-full')} style={boxStyle(draft)} />}
        </div>
      </div>

      {/* Trecho */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Scissors className="size-4 text-muted-foreground" />
          <span className="font-medium">Trecho para a IA:</span>
          <span className="text-muted-foreground">{range ? `${formatTimestamp(range.start)} → ${formatTimestamp(range.end)} (${Math.round(range.end - range.start)}s)` : pendingStart !== null ? `início em ${formatTimestamp(pendingStart)} — marque o fim` : 'vídeo inteiro'}</span>
          <span className="ml-auto font-mono text-muted-foreground">
            {formatTimestamp(now)} / {formatTimestamp(duration)}
          </span>
        </div>
        {duration > 0 && (
          <div className="relative h-2 rounded bg-muted">
            {range && <div className="absolute h-2 rounded bg-primary/70" style={{ left: `${(range.start / duration) * 100}%`, width: `${((range.end - range.start) / duration) * 100}%` }} />}
            <div className="absolute -top-0.5 h-3 w-0.5 bg-white" style={{ left: `${(now / duration) * 100}%` }} />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={markStart}>
            Marcar início aqui
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={markEnd} disabled={pendingStart === null}>
            Marcar fim aqui
          </Button>
          {(range || pendingStart !== null) && (
            <Button type="button" size="sm" variant="ghost" onClick={() => (setPendingStart(null), onRange(null))}>
              Usar o vídeo inteiro
            </Button>
          )}
        </div>
      </div>

      {/* Áreas */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant={tool === 'cam-rect' ? 'default' : 'outline'} onClick={() => setTool(tool === 'cam-rect' ? null : 'cam-rect')}>
            <Square /> Câmera (retângulo)
          </Button>
          <Button type="button" size="sm" variant={tool === 'cam-circle' ? 'default' : 'outline'} onClick={() => setTool(tool === 'cam-circle' ? null : 'cam-circle')}>
            <Circle /> Câmera (círculo no rosto)
          </Button>
          <Button type="button" size="sm" variant={tool === 'content' ? 'default' : 'outline'} onClick={() => setTool(tool === 'content' ? null : 'content')}>
            <MonitorPlay /> Conteúdo do react
          </Button>
          {(cam || content) && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onLayout(null)}>
              <Eraser /> Limpar áreas
            </Button>
          )}
        </div>
        {tool && (
          <p className="flex items-center gap-1.5 text-xs text-primary">
            <Crosshair className="size-3.5" />
            {tool === 'cam-circle' ? 'Clique no centro do rosto e arraste para fora.' : 'Clique e arraste sobre o vídeo para desenhar a área.'} (Pause o vídeo no momento que quiser.)
          </p>
        )}

        {cam && (
          <div className="space-y-2 rounded-md border bg-background/50 p-2 text-xs">
            <p className="font-medium text-sky-400">Câmera do streamer ({cam.shape === 'circle' ? 'círculo no rosto' : 'retângulo'})</p>
            {cam.shape === 'circle' && (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {(
                  [
                    { v: 'fill', t: 'Expandir para a câmera inteira', d: 'A IA acha o quadradinho em volta do rosto e ele ocupa todo o topo.' },
                    { v: 'bubble', t: 'Só o rosto no canto de cima', d: 'Rosto num círculo no canto superior, por cima do conteúdo em tela cheia.' },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => update({ cam: { ...cam, mode: o.v } })}
                    className={cn('rounded-md border p-2 text-left', cam.mode === o.v ? 'border-primary bg-primary/10' : 'hover:bg-accent/40')}
                  >
                    <span className="block font-medium">{o.t}</span>
                    <span className="block text-muted-foreground">{o.d}</span>
                  </button>
                ))}
              </div>
            )}
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>
                Acompanhar a pessoa
                <span className="block text-muted-foreground">A IA segue o rosto se ele sair do lugar marcado; desligado, a área fica fixa.</span>
              </span>
              <Switch checked={cam.track} onCheckedChange={(v) => update({ cam: { ...cam, track: v } })} />
            </label>
          </div>
        )}
        {content && (
          <div className="rounded-md border bg-background/50 p-2 text-xs">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>
                <span className="font-medium text-amber-400">Conteúdo do react</span> — dinâmico
                <span className="block text-muted-foreground">
                  A IA foca no player marcado e acompanha as mudanças: se ele mudar de lugar, ou se o streamer puser o vídeo em tela cheia, o enquadramento muda junto (e volta quando o
                  conteúdo voltar ao quadradinho). Desligado, usa sempre exatamente a área desenhada.
                </span>
              </span>
              <Switch checked={content.track} onCheckedChange={(v) => update({ content: { ...content, track: v } })} />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
