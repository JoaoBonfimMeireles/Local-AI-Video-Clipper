'use client';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** Bloco pulsante no lugar do conteúdo que ainda está carregando (evita a sensação de "surgiu do nada"). */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

type VideoProps = React.VideoHTMLAttributes<HTMLVideoElement> & { wrapperClassName?: string; ref?: React.Ref<HTMLVideoElement> };

/** Vídeo com skeleton até o primeiro quadro carregar; depois aparece com um fade. */
export function SkeletonVideo({ className, wrapperClassName, onLoadedData, onError, ref, ...props }: VideoProps) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const own = useRef<HTMLVideoElement | null>(null);
  // O vídeo pode carregar antes do React ligar o onLoadedData (hidratação)
  useEffect(() => {
    if ((own.current?.readyState ?? 0) >= 2) setReady(true);
  }, []);
  return (
    <div className={cn('relative overflow-hidden', wrapperClassName)}>
      {!ready && !failed && <Skeleton className="absolute inset-0 rounded-none" />}
      <video
        ref={(el) => {
          own.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) (ref as React.RefObject<HTMLVideoElement | null>).current = el;
        }}
        {...props}
        onLoadedData={(e) => {
          setReady(true);
          onLoadedData?.(e);
        }}
        onError={(e) => {
          setFailed(true);
          onError?.(e);
        }}
        className={cn('transition-opacity duration-500', ready ? 'opacity-100' : 'opacity-0', className)}
      />
    </div>
  );
}
