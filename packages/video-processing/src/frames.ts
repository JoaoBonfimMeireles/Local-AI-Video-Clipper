import fs from 'node:fs';
import path from 'node:path';
import { resolveBinary, runProcess } from '@clipper/shared/server';
import { runFfmpeg, sec } from './ffmpeg';

/** Detecta trocas de cena decodificando em baixa resolução (rápido mesmo para vídeos longos). */
export async function detectSceneChanges(input: string, opts: { threshold?: number; signal?: AbortSignal; onProgress?: (p: number) => void; duration?: number } = {}): Promise<number[]> {
  const t = opts.threshold ?? 0.35;
  const times: number[] = [];
  await runProcess(
    resolveBinary('ffmpeg'),
    [
      '-hide_banner', '-nostdin', '-progress', 'pipe:1', '-nostats',
      '-i', input, '-an', '-sn',
      '-vf', `fps=6,scale=256:-2,select='gt(scene,${t})',showinfo`,
      '-f', 'null', '-',
    ],
    {
      signal: opts.signal,
      captureStdout: false,
      onStdoutLine: (line) => {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && opts.duration && opts.onProgress) opts.onProgress(Math.min(1, Number(m[1]) / 1e6 / opts.duration));
      },
      onStderrLine: (line) => {
        const m = /pts_time:([\d.]+)/.exec(line);
        if (m && line.includes('Parsed_showinfo')) times.push(Number(m[1]));
      },
    },
  );
  return times;
}

/**
 * Escolhe até `max` instantes representativos: trocas de cena, picos de áudio, fins de silêncio,
 * completando com amostragem uniforme. Mantém distância mínima entre frames.
 */
export function pickFrameTimes(
  duration: number,
  hints: { scenes?: number[]; peaks?: number[]; silenceEnds?: number[] },
  max = 24,
): { time: number; reason: string }[] {
  const minGap = Math.max(4, duration / (max * 2));
  const picked: { time: number; reason: string }[] = [];
  const tryAdd = (time: number, reason: string) => {
    if (time < 0.5 || time > duration - 0.5) return;
    if (picked.some((p) => Math.abs(p.time - time) < minGap)) return;
    picked.push({ time, reason });
  };
  const spread = (arr: number[], n: number) => {
    if (arr.length <= n) return arr;
    const step = arr.length / n;
    return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
  };
  for (const t of spread(hints.scenes ?? [], Math.ceil(max * 0.4))) tryAdd(t + 0.3, 'troca de cena');
  for (const t of spread(hints.peaks ?? [], Math.ceil(max * 0.3))) tryAdd(t, 'pico de áudio');
  for (const t of spread(hints.silenceEnds ?? [], Math.ceil(max * 0.15))) tryAdd(t + 0.5, 'após silêncio');
  const uniform = Math.max(1, max - picked.length);
  for (let i = 0; i < uniform && picked.length < max; i++) tryAdd(((i + 0.5) / uniform) * duration, 'amostra uniforme');
  return picked.sort((a, b) => a.time - b.time).slice(0, max);
}

export interface ExtractedFrame {
  time: number;
  reason: string;
  path: string;
}

/** Extrai frames JPEG pequenos (seek rápido antes do -i). */
export async function extractFrames(input: string, times: { time: number; reason: string }[], outDir: string, opts: { width?: number; signal?: AbortSignal; onProgress?: (p: number) => void } = {}): Promise<ExtractedFrame[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const out: ExtractedFrame[] = [];
  for (let i = 0; i < times.length; i++) {
    const file = path.join(outDir, `frame_${String(i).padStart(3, '0')}.jpg`);
    try {
      await runFfmpeg(['-ss', sec(times[i].time), '-i', input, '-frames:v', '1', '-vf', `scale=${opts.width ?? 512}:-2`, '-q:v', '4', file], { signal: opts.signal });
      if (fs.existsSync(file)) out.push({ ...times[i], path: file });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
    }
    opts.onProgress?.((i + 1) / times.length);
  }
  return out;
}
