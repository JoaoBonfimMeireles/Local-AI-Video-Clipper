'use client';
// Velocidade das prévias (1x a 3x): uma preferência só para o app todo, lembrada no navegador. Vale para todo
// <video>/<audio> da página (inclusive os criados depois) e, via withSpeed, para os elementos fora da página.
import { useSyncExternalStore } from 'react';

export const SPEEDS = [1, 1.5, 2, 3] as const;
const KEY = 'clipper.playbackSpeed';
const listeners = new Set<() => void>();
let current = 1;

if (typeof window !== 'undefined') {
  try {
    const saved = Number(localStorage.getItem(KEY));
    if ((SPEEDS as readonly number[]).includes(saved)) current = saved;
  } catch {
    /* sem localStorage: fica 1x */
  }
  // Mídia nova na página (ou que trocou de arquivo) já toca na velocidade escolhida. Eventos de mídia não sobem
  // pela árvore, mas a fase de captura no document pega todos.
  const onMedia = (e: Event) => e.target instanceof HTMLMediaElement && withSpeed(e.target);
  document.addEventListener('play', onMedia, true);
  document.addEventListener('loadedmetadata', onMedia, true);
}

export const getPlaybackSpeed = () => current;

/** Aplica a velocidade atual (mantendo o tom da voz) e devolve o próprio elemento. */
export function withSpeed<T extends HTMLMediaElement>(el: T): T {
  if (el.dataset.fixedSpeed) return el;
  el.defaultPlaybackRate = current;
  if (el.playbackRate !== current) el.playbackRate = current;
  el.preservesPitch = true;
  return el;
}

export function setPlaybackSpeed(rate: number) {
  current = rate;
  try {
    localStorage.setItem(KEY, String(rate));
  } catch {
    /* só nesta aba */
  }
  document.querySelectorAll('video, audio').forEach((el) => withSpeed(el as HTMLMediaElement));
  listeners.forEach((l) => l());
}

/** Velocidade atual, atualizando o componente quando ela muda em qualquer lugar. */
export function usePlaybackSpeed(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => 1,
  );
}
