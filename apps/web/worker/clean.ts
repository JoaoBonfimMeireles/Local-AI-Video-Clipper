// Limpar vídeo: corta trechos, tira pausas/música/legenda/logo, recorta bordas e trata o áudio.
// Resultado em data/output/limpos/<nome>_limpo_<job>.mp4; "Levar para o editor" copia para data/input.
import fs from 'node:fs';
import path from 'node:path';
import { detectSubtitleRegion } from '@clipper/ai-providers';
import type { Job } from '@clipper/shared';
import { addJobLog, dataPaths, setJobResult, updateJobProgress } from '@clipper/shared/server';
import { cleanVideo, extractFrames, probe } from '@clipper/video-processing';

/** Faixa de progresso de cada etapa. */
const RANGES: Record<string, [number, number]> = {
  silences: [0.02, 0.08],
  cut: [0.08, 0.55],
  subtitles: [0.08, 0.55],
  music: [0.55, 0.8],
  final: [0.8, 0.92],
  stems: [0.92, 1],
};

export async function runCleanJob(job: Job, signal: AbortSignal): Promise<{ rendered: number; failed: number }> {
  const spec = { ...job.settings.clean! };
  const log = (level: 'info' | 'warn', msg: string) => {
    addJobLog(job.id, level, msg);
    console.log(`[job ${job.id.slice(0, 8)}] ${level.toUpperCase()} ${msg}`);
  };
  const tempDir = path.join(dataPaths.temp, job.id);
  fs.mkdirSync(tempDir, { recursive: true });
  updateJobProgress(job.id, 'silences', 0.01);

  if (spec.removeSubtitles && !spec.subtitleBand) {
    const info = await probe(job.inputPath, signal);
    const times = Array.from({ length: 16 }, (_, i) => ({ time: ((i + 0.5) / 16) * info.duration, reason: 'legenda' }));
    const frames = await extractFrames(job.inputPath, times, path.join(tempDir, 'frames'), { width: 640, signal });
    const r = await detectSubtitleRegion(frames.map((f) => f.path), signal);
    if (r.found && r.y !== undefined && r.h !== undefined) {
      spec.subtitleBand = { y: r.y, h: r.h };
      log('info', `Legenda detectada em ${(r.y * 100).toFixed(0)}%–${((r.y + r.h) * 100).toFixed(0)}% da altura`);
    } else {
      // Sem detecção: faixa típica de legenda (parte de baixo)
      spec.subtitleBand = { y: 0.7, h: 0.18 };
      log('warn', 'Legenda não detectada com segurança; usando a faixa de baixo (70%–88%). Marque a faixa à mão se precisar.');
    }
  }

  const outDir = path.join(dataPaths.output, 'limpos');
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.parse(spec.file).name.replace(/[^\p{L}\p{N}_\- ]/gu, '_').slice(0, 80);
  const output = path.join(outDir, `${base}_limpo_${job.id.slice(0, 6)}.mp4`);
  const res = await cleanVideo({
    input: job.inputPath,
    spec,
    output,
    workDir: tempDir,
    signal,
    log: (m) => log('info', m),
    onStep: (step, p) => {
      const [a, b] = RANGES[step] ?? [0, 1];
      updateJobProgress(job.id, step, a + (b - a) * p);
    },
  });
  setJobResult(job.id, { outputDir: outDir, cleanOutput: output, cleanStems: res.stems });
  log('info', `Vídeo limpo (${res.duration.toFixed(1)}s, ${res.removedSeconds.toFixed(1)}s removidos): ${output}`);
  updateJobProgress(job.id, 'stems', 1);
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* arquivo ainda preso pelo Windows: cleanOrphanTemp apaga na próxima inicialização */
  }
  return { rendered: 1, failed: 0 };
}
