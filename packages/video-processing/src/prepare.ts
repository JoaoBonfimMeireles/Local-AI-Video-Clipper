import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pythonScriptPath, resolveBinary, resolvePythonBinary } from '@clipper/shared/server';
import { runFfmpeg, sec } from './ffmpeg';

export interface Segment {
  start: number;
  end: number;
}

export interface PrepareOptions {
  input: string;
  segments: Segment[];
  source: { width: number; height: number; fps: number; hasAudio: boolean };
  /** Faixa com legenda antiga a remover (frações da altura). */
  subtitleRegion?: { y: number; h: number } | null;
  output: string;
  workDir: string;
  signal?: AbortSignal;
  onProgress?: (p: number) => void;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Gera o vídeo-fonte de um corte: trechos concatenados (na ordem dada) e, opcionalmente,
 * com a legenda antiga apagada. O resultado começa em 0 e é usado pelo renderClip.
 */
export async function prepareClipSource(opts: PrepareOptions): Promise<{ duration: number }> {
  fs.mkdirSync(opts.workDir, { recursive: true });
  const total = opts.segments.reduce((a, s) => a + (s.end - s.start), 0);
  const parts: string[] = [];
  let done = 0;
  for (let i = 0; i < opts.segments.length; i++) {
    const seg = opts.segments[i];
    const dur = seg.end - seg.start;
    const part = path.join(opts.workDir, `part_${i}.mp4`);
    const tick = (p: number) => opts.onProgress?.((done + p * dur) / total);
    if (opts.subtitleRegion) await renderInpaintedSegment(opts, seg, part, tick);
    else await renderPlainSegment(opts, seg, part, tick);
    parts.push(part);
    done += dur;
  }
  if (parts.length === 1) {
    fs.renameSync(parts[0], opts.output);
  } else {
    // Concatena sem reencodar (todos os pedaços têm os mesmos parâmetros)
    const list = path.join(opts.workDir, 'parts.txt');
    fs.writeFileSync(list, parts.map((p) => `file '${path.basename(p)}'`).join('\n'));
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', 'parts.txt', '-c', 'copy', opts.output], { cwd: opts.workDir, signal: opts.signal });
  }
  return { duration: total };
}

function encodeArgs(fps: number): string[] {
  // Intermediário de alta qualidade: será reencodado no render final
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
}

function audioArgs(hasAudio: boolean, dur: number): { input: string[]; map: string[] } {
  if (hasAudio) return { input: [], map: ['-map', '0:a:0'] };
  return { input: ['-f', 'lavfi', '-t', sec(dur), '-i', 'anullsrc=r=48000:cl=stereo'], map: [] };
}

async function renderPlainSegment(opts: PrepareOptions, seg: Segment, out: string, onProgress: (p: number) => void) {
  const dur = seg.end - seg.start;
  const fps = Math.min(60, Math.round(opts.source.fps || 30));
  const a = audioArgs(opts.source.hasAudio, dur);
  await runFfmpeg(
    [
      '-ss', sec(seg.start), '-t', sec(dur), '-i', opts.input, ...a.input,
      '-map', '0:v:0', ...(opts.source.hasAudio ? a.map : ['-map', '1:a:0']),
      ...encodeArgs(fps), '-t', sec(dur), out,
    ],
    { signal: opts.signal, expectedDuration: dur, onProgress },
  );
}

/**
 * decoder (só a faixa da legenda, BGR24) -> inpaint_subtitles.py -> encoder (sobrepõe a faixa limpa
 * no frame original). Tudo em streaming: nenhum frame bruto vai para o disco.
 */
async function renderInpaintedSegment(opts: PrepareOptions, seg: Segment, out: string, onProgress: (p: number) => void) {
  const dur = seg.end - seg.start;
  const fps = Math.min(60, Math.round(opts.source.fps || 30));
  const { width: W, height: H } = opts.source;
  const region = opts.subtitleRegion!;
  const y = Math.min(even(region.y * H), H - 4);
  const h = Math.min(even(region.h * H), H - y);
  const ffmpeg = resolveBinary('ffmpeg');

  const decoder = spawn(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', sec(seg.start), '-t', sec(dur), '-i', opts.input,
      '-an', '-vf', `fps=${fps},crop=${W}:${h}:0:${y}`, '-f', 'rawvideo', '-pix_fmt', 'bgr24', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const py = spawn(resolvePythonBinary(), [pythonScriptPath('inpaint_subtitles.py'), '--width', String(W), '--height', String(h), '--fps', String(fps)], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const a = audioArgs(opts.source.hasAudio, dur);
  const encoder = spawn(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:2', '-nostats',
      '-ss', sec(seg.start), '-t', sec(dur), '-i', opts.input,
      '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', `${W}x${h}`, '-r', String(fps), '-i', 'pipe:0',
      ...a.input,
      '-filter_complex', `[0:v]fps=${fps}[base];[1:v]format=yuv420p[clean];[base][clean]overlay=x=0:y=${y}:eof_action=pass:shortest=0[v]`,
      '-map', '[v]', ...(opts.source.hasAudio ? a.map : ['-map', '2:a:0']),
      ...encodeArgs(fps), '-t', sec(dur), out],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] },
  );

  decoder.stdout.pipe(py.stdin);
  py.stdout.pipe(encoder.stdin);
  // Erros de pipe (processo encerrado antes do fim) são reportados pelo código de saída
  for (const s of [decoder.stdout, py.stdin, py.stdout, encoder.stdin]) s.on('error', () => undefined);

  const errs: Record<string, string> = { decoder: '', python: '', encoder: '' };
  decoder.stderr.on('data', (d) => (errs.decoder = (errs.decoder + d).slice(-3000)));
  py.stderr.on('data', (d) => (errs.python = (errs.python + d).slice(-3000)));
  encoder.stderr.on('data', (d: Buffer) => {
    const text = d.toString();
    const m = /out_time_us=(\d+)/.exec(text);
    if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / dur));
    else errs.encoder = (errs.encoder + text).slice(-3000);
  });

  const procs = [decoder, py, encoder];
  const kill = () => procs.forEach((p) => p.pid && spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => p.kill('SIGKILL')));
  opts.signal?.addEventListener('abort', kill, { once: true });

  const codes = await Promise.all(procs.map((p) => new Promise<number | null>((resolve) => p.on('close', resolve))));
  opts.signal?.removeEventListener('abort', kill);
  if (opts.signal?.aborted) throw new Error('cancelado');
  if (codes[2] !== 0 || !fs.existsSync(out)) {
    const detail = [errs.encoder, errs.python, errs.decoder].map((e) => e.trim()).filter(Boolean).join('\n').split('\n').slice(-8).join('\n');
    throw new Error(`Remoção de legenda falhou (decoder ${codes[0]}, python ${codes[1]}, encoder ${codes[2]}):\n${detail}`);
  }
}

/** Frames a cada 1/fps segundos ao longo de um corte, com uma única chamada do FFmpeg por trecho. */
export async function extractClipFramesFps(input: string, segments: Segment[], outDir: string, opts: { fps?: number; width?: number; signal?: AbortSignal } = {}): Promise<{ time: number; path: string }[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const fps = opts.fps ?? 1;
  const frames: { time: number; path: string }[] = [];
  let offset = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dur = seg.end - seg.start;
    const pattern = `s${i}_%04d.jpg`;
    await runFfmpeg(['-ss', sec(seg.start), '-t', sec(dur), '-i', input, '-an', '-vf', `fps=${fps},scale=${opts.width ?? 480}:-2`, '-q:v', '5', pattern], { cwd: outDir, signal: opts.signal });
    const files = fs.readdirSync(outDir).filter((f) => f.startsWith(`s${i}_`)).sort();
    files.forEach((f, k) => frames.push({ time: Number((offset + k / fps + 0.02).toFixed(2)), path: path.join(outDir, f) }));
    offset += dur;
  }
  return frames;
}

/** Extrai frames pequenos ao longo de um corte (para a IA analisar enquadramento). */
export async function extractClipFrames(input: string, segments: Segment[], outDir: string, opts: { every?: number; max?: number; width?: number; signal?: AbortSignal } = {}): Promise<{ time: number; path: string }[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const total = segments.reduce((a, s) => a + (s.end - s.start), 0);
  const every = Math.max(opts.every ?? 3, total / (opts.max ?? 12));
  const frames: { time: number; path: string }[] = [];
  let offset = 0;
  for (const seg of segments) {
    for (let t = 0.5; t < seg.end - seg.start; t += every) {
      const file = path.join(outDir, `f_${frames.length.toString().padStart(3, '0')}.jpg`);
      try {
        await runFfmpeg(['-ss', sec(seg.start + t), '-i', input, '-frames:v', '1', '-vf', `scale=${opts.width ?? 384}:-2`, '-q:v', '5', file], { signal: opts.signal });
        if (fs.existsSync(file)) frames.push({ time: Number((offset + t).toFixed(2)), path: file });
      } catch (e) {
        if (opts.signal?.aborted) throw e;
      }
    }
    offset += seg.end - seg.start;
  }
  return frames;
}
