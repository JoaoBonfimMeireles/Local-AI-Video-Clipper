import { resolveBinary, runProcess } from '@clipper/shared/server';
import { runFfmpeg } from './ffmpeg';

/** Extrai áudio mono 16 kHz PCM (formato ideal para o Whisper). */
export async function extractAudio(input: string, outWav: string, opts: { signal?: AbortSignal; duration?: number; onProgress?: (p: number) => void } = {}) {
  await runFfmpeg(['-i', input, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav], {
    signal: opts.signal,
    expectedDuration: opts.duration,
    onProgress: opts.onProgress,
  });
}

/**
 * Curva de energia: RMS (dBFS) por janela de 1s. Usada para detectar picos (risadas, gritos, ênfase)
 * na seleção de cortes e na amostragem visual.
 */
export async function analyzeEnergy(wav16k: string, signal?: AbortSignal): Promise<number[]> {
  const res = await runProcess(
    resolveBinary('ffmpeg'),
    [
      '-hide_banner', '-nostdin', '-i', wav16k,
      '-af', 'asetnsamples=n=16000:p=0,astats=metadata=1:reset=1:measure_overall=RMS_level:measure_perchannel=none,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f', 'null', '-',
    ],
    { signal },
  );
  const values: number[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = /RMS_level=(-?[\d.]+|-inf)/.exec(line);
    if (m) values.push(m[1] === '-inf' ? -90 : Math.max(-90, Number(m[1])));
  }
  return values;
}

export interface Silence {
  start: number;
  end: number;
}

export async function detectSilences(wav16k: string, opts: { noiseDb?: number; minDuration?: number; signal?: AbortSignal } = {}): Promise<Silence[]> {
  const silences: Silence[] = [];
  let current: number | null = null;
  await runProcess(
    resolveBinary('ffmpeg'),
    ['-hide_banner', '-nostdin', '-i', wav16k, '-af', `silencedetect=noise=${opts.noiseDb ?? -35}dB:d=${opts.minDuration ?? 0.6}`, '-f', 'null', '-'],
    {
      signal: opts.signal,
      onStderrLine: (line) => {
        const s = /silence_start: (-?[\d.]+)/.exec(line);
        if (s) current = Math.max(0, Number(s[1]));
        const e = /silence_end: ([\d.]+)/.exec(line);
        if (e && current !== null) {
          silences.push({ start: current, end: Number(e[1]) });
          current = null;
        }
      },
    },
  );
  return silences;
}

/** Índices (segundos) com energia acima de média + k*desvio. */
export function findEnergyPeaks(energy: number[], k = 1.2, minGap = 3): number[] {
  const voiced = energy.filter((e) => e > -60);
  if (!voiced.length) return [];
  const mean = voiced.reduce((a, b) => a + b, 0) / voiced.length;
  const std = Math.sqrt(voiced.reduce((a, b) => a + (b - mean) ** 2, 0) / voiced.length) || 1;
  const peaks: number[] = [];
  for (let i = 1; i < energy.length - 1; i++) {
    if (energy[i] > mean + k * std && energy[i] >= energy[i - 1] && energy[i] >= energy[i + 1]) {
      if (!peaks.length || i - peaks[peaks.length - 1] >= minGap) peaks.push(i);
    }
  }
  return peaks;
}
