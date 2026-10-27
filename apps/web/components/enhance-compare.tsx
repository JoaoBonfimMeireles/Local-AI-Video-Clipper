'use client';
// Comparação do "Melhorar qualidade" antes de usar: o mesmo quadro na resolução final em cada versão, lado a lado.
import { useState } from 'react';
import { Check, Maximize2, X } from 'lucide-react';
import { upscaleModelLabel, type UpscaleModel } from '@clipper/shared';
import { fileUrl } from '@/lib/client';
import { cn } from '@/lib/utils';

export interface EnhanceShot {
  images: { original: string } & Partial<Record<UpscaleModel, string>>;
  width: number;
  height: number;
  /** Tamanho da área no vídeo original. */
  source: { width: number; height: number };
}

/** Ponto da lupa (0..1 na imagem), o mesmo em todas as versões. */
type Focus = { x: number; y: number } | null;

/**
 * Imagem da prévia com lupa: passando o mouse, todas as versões ampliam o mesmo ponto (miniatura não mostra diferença).
 * O servidor ocupado (render rodando) às vezes falha a 1ª leitura, então a imagem tenta mais algumas vezes.
 */
function PreviewImage({ file, alt, aspect, focus, zoom, onFocus }: { file: string; alt: string; aspect: string; focus: Focus; zoom: number; onFocus: (f: Focus) => void }) {
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onFocus({ x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) });
  };
  return (
    <div className="relative w-full cursor-zoom-in overflow-hidden rounded border bg-black" style={{ aspectRatio: aspect }} onPointerMove={move} onPointerDown={move} onPointerLeave={() => onFocus(null)}>
      <img
        src={fileUrl(file)}
        alt={alt}
        draggable={false}
        className="size-full object-contain"
        style={focus ? { transform: `scale(${zoom})`, transformOrigin: `${focus.x * 100}% ${focus.y * 100}%` } : undefined}
        onError={(e) => {
          const img = e.currentTarget;
          const n = Number(img.dataset.retry ?? 0);
          if (n < 4) {
            img.dataset.retry = String(n + 1);
            setTimeout(() => (img.src = `${fileUrl(file)}&r=${n + 1}`), 700);
          }
        }}
      />
    </div>
  );
}

/** value: versão escolhida (null = original, sem melhorar). */
export function EnhanceCompare({ shot, value, onPick, className }: { shot: EnhanceShot; value: UpscaleModel | null; onPick: (m: UpscaleModel | null) => void; className?: string }) {
  const options: { model: UpscaleModel | null; file: string; label: string }[] = [
    { model: null, file: shot.images.original, label: 'Original (sem melhorar)' },
    ...(Object.entries(shot.images) as [string, string][])
      .filter(([k]) => k !== 'original')
      .map(([k, file]) => ({ model: k as UpscaleModel, file, label: upscaleModelLabel(k as UpscaleModel) })),
  ];
  const [big, setBig] = useState(false);
  const [focus, setFocus] = useState<Focus>(null);
  const [zoom, setZoom] = useState(3);
  const zoomPicker = (large: boolean) => (
    <span className={cn('inline-flex items-center gap-1', large ? 'text-sm' : 'text-[11px]')}>
      Lupa:
      {[2, 3, 5].map((z) => (
        <button key={z} type="button" className={cn('rounded px-1.5 py-0.5', zoom === z ? 'bg-primary text-primary-foreground' : 'border hover:bg-muted', large && zoom !== z && 'border-white/30 hover:bg-white/10')} onClick={() => setZoom(z)}>
          {z}x
        </button>
      ))}
    </span>
  );
  const grid = (large: boolean) => (
    <div className={cn('grid', large ? 'gap-3' : 'gap-1.5')} style={{ gridTemplateColumns: large ? `repeat(${options.length}, minmax(0, 1fr))` : 'repeat(auto-fill, minmax(120px, 1fr))' }}>
      {options.map((o) => {
        const on = value === o.model;
        return (
          <figure key={o.label} className={cn('space-y-1 rounded-md border-2 p-1', on ? 'border-primary' : 'border-transparent')}>
            <PreviewImage file={o.file} alt={o.label} aspect={`${shot.width} / ${shot.height}`} focus={focus} zoom={zoom} onFocus={setFocus} />
            <figcaption className={cn('text-center leading-tight', large ? 'text-sm' : 'text-[11px]')}>{o.label}</figcaption>
            <button
              type="button"
              className={cn('flex w-full items-center justify-center gap-1 rounded px-1 py-0.5 font-medium', large ? 'text-sm' : 'text-[11px]', on ? 'bg-primary text-primary-foreground' : 'border hover:bg-muted', large && !on && 'border-white/30 hover:bg-white/10')}
              onClick={() => onPick(o.model)}
            >
              {on ? (
                <>
                  <Check className="size-3" /> Escolhida
                </>
              ) : (
                'Usar esta'
              )}
            </button>
          </figure>
        );
      })}
    </div>
  );
  return (
    <div className={cn('space-y-1.5', className)}>
      {grid(false)}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>
          Mesmo quadro, de {shot.source.width}x{shot.source.height} para {shot.width}x{shot.height} px. Passe o mouse numa imagem: a lupa amplia o mesmo ponto em todas (olhe os rostos e as bordas).
        </span>
        {zoomPicker(false)}
        <button type="button" className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-foreground hover:bg-muted" onClick={() => setBig(true)}>
          <Maximize2 className="size-3" /> Ver lado a lado em tela cheia
        </button>
      </div>
      {big && (
        <div className="fixed inset-0 z-[80] flex flex-col gap-3 bg-black/90 p-4 text-white" onClick={() => setBig(false)}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm" onClick={(e) => e.stopPropagation()}>
            <b>
              Compare e escolha a versão ({shot.width}x{shot.height}) · passe o mouse para ampliar
            </b>
            <div className="flex items-center gap-3">
              {zoomPicker(true)}
              <button type="button" className="rounded p-1 hover:bg-white/10" title="Fechar" onClick={() => setBig(false)}>
                <X className="size-5" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto" onClick={(e) => e.stopPropagation()}>
            {grid(true)}
          </div>
        </div>
      )}
    </div>
  );
}
