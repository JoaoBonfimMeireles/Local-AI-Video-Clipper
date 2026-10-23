// Efeito sonoro sem atropelar a fala: o vídeo PAUSA (quadro congelado), o som toca sozinho e o vídeo continua.
import { runFfmpeg } from './ffmpeg';

const num = (n: number, d = 3) => (Number.isFinite(n) ? Number(n.toFixed(d)).toString() : '0');

export interface SoundPause {
  /** Instante no corte (antes da pausa) em que o vídeo congela. */
  at: number;
  /** Quanto tempo fica congelado (= duração do som). */
  duration: number;
  file: string;
  volume: number;
}

interface TimedWord {
  start: number;
  end: number;
}

/**
 * Converte efeitos sonoros em pausas: cada som vai para o fim da palavra mais próxima (nunca no meio de uma
 * palavra), com no máximo `maxPauses` por corte e sem pausas grudadas umas nas outras.
 */
export function planSoundPauses(
  sfx: { file: string; at: number; volume: number; duration?: number }[],
  words: TimedWord[],
  clipDuration: number,
  maxPauses = 3,
): SoundPause[] {
  const out: SoundPause[] = [];
  for (const s of [...sfx].sort((a, b) => a.at - b.at)) {
    if (out.length >= maxPauses) break;
    // Fim de palavra mais perto do instante pedido (ou o próprio instante, se cair num silêncio)
    const inside = words.find((w) => s.at > w.start && s.at < w.end);
    let at = s.at;
    if (inside) {
      const ends = words.map((w) => w.end).filter((e) => Math.abs(e - s.at) < 2.5);
      at = ends.length ? ends.reduce((a, b) => (Math.abs(b - s.at) < Math.abs(a - s.at) ? b : a)) : inside.end;
    }
    at = Math.min(Math.max(0.3, at), clipDuration - 0.3);
    if (out.some((p) => Math.abs(p.at - at) < 2)) continue;
    out.push({ at: Number(at.toFixed(3)), duration: Math.min(2.5, Math.max(0.4, s.duration ?? 1.2)), file: s.file, volume: s.volume });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Tempos depois de cada pausa andam para frente (SRT e legendas externas continuam sincronizados). */
export function shiftForPauses<T extends TimedWord>(items: T[], pauses: SoundPause[]): T[] {
  return items.map((w) => {
    const d = pauses.filter((p) => p.at <= w.start + 0.01).reduce((a, p) => a + p.duration, 0);
    return d ? { ...w, start: w.start + d, end: w.end + d } : w;
  });
}

/**
 * Insere as pausas no vídeo já renderizado: corta nos instantes, congela o último quadro de cada parte
 * pela duração do som (tpad) e põe o som nesse intervalo, com o áudio original em silêncio.
 */
export async function insertSoundPauses(args: {
  input: string;
  output: string;
  pauses: SoundPause[];
  duration: number;
  videoCodec: string[];
  signal?: AbortSignal;
}): Promise<void> {
  const ps = args.pauses;
  const n = ps.length;
  const f: string[] = [];
  f.push(`[0:v]split=${n + 1}${ps.map((_, i) => `[v${i}]`).join('')}[v${n}]`);
  f.push(`[0:a]asplit=${n + 1}${ps.map((_, i) => `[a${i}]`).join('')}[a${n}]`);
  const cuts = [0, ...ps.map((p) => p.at), args.duration];
  const pairs: string[] = [];
  for (let k = 0; k <= n; k++) {
    const a = num(cuts[k]);
    const b = num(cuts[k + 1]);
    const last = k === n;
    f.push(`[v${k}]trim=start=${a}${last ? '' : `:end=${b}`},setpts=PTS-STARTPTS${last ? '' : `,tpad=stop_mode=clone:stop_duration=${num(ps[k].duration)}`}[pv${k}]`);
    f.push(`[a${k}]atrim=start=${a}${last ? '' : `:end=${b}`},asetpts=PTS-STARTPTS[pa${k}]`);
    if (last) {
      pairs.push(`[pv${k}][pa${k}]`);
    } else {
      const d = num(ps[k].duration);
      f.push(`[${k + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${num(Math.min(2, Math.max(0, ps[k].volume)), 2)},atrim=0:${d},afade=t=out:st=${num(Math.max(0, ps[k].duration - 0.2))}:d=0.2,apad=whole_dur=${d},atrim=0:${d}[sx${k}]`);
      f.push(`[pa${k}][sx${k}]concat=n=2:v=0:a=1[pc${k}]`);
      pairs.push(`[pv${k}][pc${k}]`);
    }
  }
  f.push(`${pairs.join('')}concat=n=${n + 1}:v=1:a=1[vout][aout]`);
  const total = args.duration + ps.reduce((a, p) => a + p.duration, 0);
  await runFfmpeg(
    [
      '-i', args.input,
      ...ps.flatMap((p) => ['-i', p.file]),
      '-filter_complex', f.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      ...args.videoCodec,
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-movflags', '+faststart',
      args.output,
    ],
    { signal: args.signal, expectedDuration: total },
  );
}
