// "Limpar vídeo": corta trechos e pausas, apaga legenda queimada e logos, recorta bordas pretas,
// separa a voz da música (Demucs) e trata o áudio (ruído + volume). Tudo local.
import fs from 'node:fs';
import path from 'node:path';
import { keptSegments, type CleanSpec, type CleanStems } from '@clipper/shared';
import { pythonScriptPath, resolveBinary, resolvePythonBinary, runProcess } from '@clipper/shared/server';
import { detectSilences, extractAudio } from './audio';
import { runFfmpeg, sec } from './ffmpeg';
import { prepareClipSource } from './prepare';
import { probe } from './probe';

export interface CleanOptions {
  input: string;
  spec: CleanSpec;
  output: string;
  workDir: string;
  signal?: AbortSignal;
  onStep?: (step: string, p: number) => void;
  log?: (msg: string) => void;
}

/** Retângulo útil do vídeo (sem as faixas pretas), ou null se não houver borda que valha cortar. */
export async function detectBlackBars(input: string, duration: number, signal?: AbortSignal): Promise<{ w: number; h: number; x: number; y: number } | null> {
  const info = await probe(input, signal);
  let last: RegExpExecArray | null = null;
  const start = Math.max(0, duration / 2 - 10);
  await runProcess(resolveBinary('ffmpeg'), ['-hide_banner', '-nostdin', '-ss', sec(start), '-t', '20', '-i', input, '-an', '-vf', 'fps=2,cropdetect=limit=24:round=2:reset=0', '-f', 'null', '-'], {
    signal,
    onStderrLine: (line) => {
      const m = /crop=(\d+):(\d+):(\d+):(\d+)/.exec(line);
      if (m) last = m;
    },
  });
  if (!last) return null;
  const [w, h, x, y] = (last as RegExpExecArray).slice(1).map(Number);
  // Só vale se tirar pelo menos 2% de algum lado
  if (w * h < 64 * 64 || (w >= info.width * 0.98 && h >= info.height * 0.98)) return null;
  return { w, h, x, y };
}

export async function cleanVideo(opts: CleanOptions): Promise<{ duration: number; removedSeconds: number; crop: { w: number; h: number } | null; stems: CleanStems }> {
  const { spec, signal } = opts;
  const step = opts.onStep ?? (() => undefined);
  const log = opts.log ?? (() => undefined);
  fs.mkdirSync(opts.workDir, { recursive: true });
  const info = await probe(opts.input, signal);

  // 1) Trechos mantidos: tudo menos os cortes marcados e (opcional) as pausas sem fala
  const cuts = [...spec.cuts];
  if (spec.trimSilence && info.hasAudio) {
    step('silences', 0);
    const wav = path.join(opts.workDir, 'src16k.wav');
    await extractAudio(opts.input, wav, { signal, duration: info.duration });
    const pad = 0.15;
    const silences = (await detectSilences(wav, { noiseDb: -35, minDuration: Math.max(0.3, spec.minSilence), signal }))
      .map((s) => ({ start: s.start + pad, end: s.end - pad }))
      .filter((s) => s.end - s.start > 0.1);
    log(`${silences.length} pausa(s) sem fala encontradas (${silences.reduce((a, s) => a + s.end - s.start, 0).toFixed(1)}s)`);
    cuts.push(...silences);
  }
  const segments = keptSegments(info.duration, cuts, 0.2);
  if (!segments.length) throw new Error('Os cortes removem o vídeo inteiro.');
  const kept = segments.reduce((a, s) => a + s.end - s.start, 0);

  // 2) Corta e (opcional) apaga a legenda queimada — mesmo caminho dos cortes do pipeline
  step('cut', 0);
  const stage1 = path.join(opts.workDir, 'stage1.mp4');
  await prepareClipSource({
    input: opts.input,
    segments,
    source: { width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio },
    subtitleRegion: spec.removeSubtitles ? spec.subtitleBand : null,
    output: stage1,
    workDir: path.join(opts.workDir, 'parts'),
    signal,
    onProgress: (p) => step(spec.removeSubtitles ? 'subtitles' : 'cut', p),
  });

  // 3) Bordas pretas
  const crop = spec.cropBlackBars ? await detectBlackBars(stage1, kept, signal) : null;
  if (spec.cropBlackBars) log(crop ? `Bordas pretas: recortando para ${crop.w}x${crop.h}` : 'Nenhuma borda preta encontrada');

  // 4) Música: Demucs separa a voz do resto
  let vocals: string | null = null;
  const musicWav = path.join(opts.workDir, 'music.wav');
  if ((spec.removeMusic || spec.exportStems) && info.hasAudio) {
    step('music', 0);
    const wav = path.join(opts.workDir, 'mix44k.wav');
    await runFfmpeg(['-i', stage1, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', wav], { signal });
    vocals = path.join(opts.workDir, 'vocals.wav');
    log('Separando a voz da música (Demucs)…');
    const res = await runProcess(resolvePythonBinary(), [pythonScriptPath('separate_vocals.py'), wav, vocals, ...(spec.exportStems ? ['--music', musicWav] : [])], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_SYMLINKS_WARNING: '1', PYTHONWARNINGS: 'ignore' },
      signal,
      stderrTailBytes: 4000,
      onStderrLine: (l) => {
        const m = /(\d+)%\|/.exec(l);
        if (m) step('music', Number(m[1]) / 100);
        else if (l.startsWith('Demucs') || l.includes('GPU falhou')) log(l.trim());
      },
    });
    if (res.code !== 0 || !fs.existsSync(vocals)) throw new Error(`Separação de voz falhou:\n${res.stderrTail.split('\n').slice(-6).join('\n')}`);
  }

  // 5) Render final: logos, recorte e tratamento do áudio
  step('final', 0);
  const W = info.width;
  const H = info.height;
  const vf: string[] = [];
  for (const b of spec.logos) {
    const x = Math.max(1, Math.round(b.x * W));
    const y = Math.max(1, Math.round(b.y * H));
    const w = Math.max(4, Math.min(Math.round(b.w * W), W - x - 1));
    const h = Math.max(4, Math.min(Math.round(b.h * H), H - y - 1));
    vf.push(`delogo=x=${x}:y=${y}:w=${w}:h=${h}`);
  }
  if (crop) vf.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  const af: string[] = [];
  if (spec.denoise) af.push('highpass=f=70', 'afftdn=nr=12:nf=-30:tn=1');
  if (spec.normalizeAudio) af.push('loudnorm=I=-14:TP=-1.5:LRA=11');
  const hasAudio = info.hasAudio;
  // Só troca o áudio pela voz quando é para tirar a música ("Separar em faixas" sozinho mantém o som original)
  const useVocals = spec.removeMusic && !!vocals;
  await runFfmpeg(
    [
      '-i', stage1, ...(useVocals ? ['-i', vocals!] : []),
      '-map', '0:v:0', ...(hasAudio ? ['-map', useVocals ? '1:a:0' : '0:a:0'] : []),
      ...(vf.length ? ['-vf', vf.join(',')] : []),
      ...(hasAudio && af.length ? ['-af', af.join(',')] : []),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'] : []),
      '-movflags', '+faststart', '-t', sec(kept), opts.output,
    ],
    { signal, expectedDuration: kept, onProgress: (p) => step('final', p) },
  );

  // 6) Faixas separadas para baixar
  const stems: CleanStems = {};
  if (spec.exportStems) {
    step('stems', 0);
    const base = opts.output.replace(/\.mp4$/i, '');
    const toM4a = async (wav: string, out: string) => {
      await runFfmpeg(['-i', wav, '-c:a', 'aac', '-b:a', '192k', out], { signal });
      return out;
    };
    if (vocals) stems.voice = await toM4a(vocals, `${base}_voz.m4a`);
    if (vocals && fs.existsSync(musicWav)) stems.music = await toM4a(musicWav, `${base}_musica.m4a`);
    stems.silentVideo = `${base}_sem_som.mp4`;
    await runFfmpeg(['-i', opts.output, '-map', '0:v:0', '-c:v', 'copy', '-an', '-movflags', '+faststart', stems.silentVideo], { signal });
    step('stems', 0.5);
    // Trechos marcados para cortar, juntos num vídeo (o que saiu do vídeo)
    const removed = keptSegments(info.duration, keptSegments(info.duration, spec.cuts, 0), 0.2);
    if (spec.cuts.length && removed.length) {
      stems.cutouts = `${base}_trechos_cortados.mp4`;
      await prepareClipSource({
        input: opts.input,
        segments: removed,
        source: { width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio },
        output: stems.cutouts,
        workDir: path.join(opts.workDir, 'cutouts'),
        signal,
        onProgress: (p) => step('stems', 0.5 + p / 2),
      });
    }
  }
  return { stems, duration: kept, removedSeconds: info.duration - kept, crop: crop ? { w: crop.w, h: crop.h } : null };
}
