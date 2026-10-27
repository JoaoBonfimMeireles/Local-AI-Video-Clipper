'use client';
import { Gauge } from 'lucide-react';
import { setPlaybackSpeed, SPEEDS, usePlaybackSpeed } from '@/lib/playback-speed';
import { cn } from '@/lib/utils';

/** Velocidade da prévia (1x, 1,5x, 2x, 3x). A escolha vale para todas as prévias do app. */
export function SpeedPicker({ className }: { className?: string }) {
  const speed = usePlaybackSpeed();
  return (
    <div className={cn('inline-flex items-center gap-1 text-xs', className)} title="Velocidade da prévia (só para assistir; não muda o vídeo final)">
      <Gauge className="size-3.5 text-muted-foreground" />
      <div className="flex overflow-hidden rounded-md border">
        {SPEEDS.map((s) => (
          <button
            type="button"
            key={s}
            className={cn('px-1.5 py-0.5 font-mono tabular-nums', speed === s ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
            onClick={() => setPlaybackSpeed(s)}
          >
            {String(s).replace('.', ',')}x
          </button>
        ))}
      </div>
    </div>
  );
}
