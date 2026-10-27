'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export function fileUrl(absPath: string, download = false) {
  return `/api/files?path=${encodeURIComponent(absPath)}${download ? '&download=1' : ''}`;
}

/** Busca periódica simples (o "tempo real" do dashboard). */
/**
 * Consulta periódica (pausa com a aba escondida). `intervalMs` pode ser uma função do último resultado: ex. rápido
 * enquanto há job rodando e devagar quando está tudo parado.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number | ((data: T | null) => number), deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const dataRef = useRef<T | null>(null);
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;

  const refresh = useCallback(async () => {
    try {
      const d = await fetcherRef.current();
      dataRef.current = d;
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState === 'visible') await refresh();
      const ms = intervalRef.current;
      timer = setTimeout(tick, typeof ms === 'function' ? ms(dataRef.current) : ms);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeof intervalMs === 'number' ? intervalMs : 0, refresh, ...deps]);

  return { data, error, refresh };
}

/** Upload com progresso (XHR, pois fetch não reporta progresso de envio). */
export function uploadFile(file: File, onProgress: (p: number) => void): Promise<{ name: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/upload');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const body = JSON.parse(xhr.responseText || '{}');
      xhr.status < 300 ? resolve(body) : reject(new Error(body.error ?? `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Falha de rede no upload'));
    xhr.send(file);
  });
}

/** Upload de logo/imagem/som para data/meme-studio/assets (XHR, com progresso). */
export function uploadMemeAsset(file: File, onProgress: (p: number) => void): Promise<{ path: string; kind: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/memes/assets');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const body = JSON.parse(xhr.responseText || '{}');
      xhr.status < 300 ? resolve(body) : reject(new Error(body.error ?? `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Falha de rede no upload'));
    xhr.send(file);
  });
}
