// Teste ponta a ponta sem UI: cria um job para um vídeo curto em data/input, roda o pipeline
// completo no processo atual e valida os arquivos gerados (MP4 com vídeo+áudio, SRT, JSON).
// Uso: npm run test:e2e [-- arquivo.mp4]   (sem argumento usa/gera data/input/teste_podcast.mp4)
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_JOB_SETTINGS } from '@clipper/shared';
import { createJob, dataPaths, finishJob, getJob, claimNextJob, listClips, loadRootEnv, runProcess } from '@clipper/shared/server';
import { probe } from '@clipper/video-processing';
import { runPipeline } from '../apps/web/worker/pipeline';

async function main() {
  loadRootEnv();
  // Por padrão o teste não gasta cota de IA (use CLIPPER_FORCE_PROVIDER=gemini para testar com IA)
  process.env.CLIPPER_FORCE_PROVIDER ??= 'heuristic';
  const name = process.argv[2] ?? 'teste_podcast.mp4';
  const input = path.join(dataPaths.input, path.basename(name));
  if (!fs.existsSync(input)) {
    console.log('Vídeo de teste não encontrado; gerando com TTS...');
    const r = await runProcess(process.execPath, [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/make-test-video.ts', input], {});
    if (r.code !== 0) throw new Error(r.stderrTail);
  }

  const job = createJob(input, `e2e_${path.parse(input).name}`, {
    ...DEFAULT_JOB_SETTINGS,
    targetDuration: 30,
    intensity: 'high',
    format: 'vertical_blur',
    removeOldSubtitles: true,
  });
  // Garante que este processo (e não um worker rodando) pegue o job
  const claimed = claimNextJob();
  if (claimed?.id !== job.id) throw new Error('Há outros jobs pendentes na fila; esvazie-a ou pare o worker antes do teste.');

  const t0 = Date.now();
  const ac = new AbortController();
  const { rendered, failed } = await runPipeline(claimed, ac.signal);
  finishJob(job.id, rendered ? 'completed' : 'failed');
  console.log(`Pipeline: ${rendered} renderizado(s), ${failed} falha(s) em ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const outDir = getJob(job.id)!.result!.outputDir!;
  const problems: string[] = [];
  for (const c of listClips(job.id)) {
    if (c.status !== 'completed' || !c.outputPath) {
      problems.push(`corte ${c.index + 1}: ${c.status} ${c.error ?? ''}`);
      continue;
    }
    const info = await probe(c.outputPath);
    const expected = c.end - c.start;
    if (info.width !== 1080 || info.height !== 1920) problems.push(`corte ${c.index + 1}: resolução ${info.width}x${info.height}`);
    if (!info.hasAudio) problems.push(`corte ${c.index + 1}: sem áudio`);
    if (Math.abs(info.duration - expected) > 1) problems.push(`corte ${c.index + 1}: duração ${info.duration.toFixed(1)}s (esperado ${expected.toFixed(1)}s)`);
    for (const f of [c.srtPath, c.metadataPath]) if (!f || !fs.existsSync(f)) problems.push(`corte ${c.index + 1}: arquivo ausente ${f}`);
    console.log(`  ✔ ${path.relative(dataPaths.root, c.outputPath)} — ${info.duration.toFixed(1)}s ${info.width}x${info.height} — nota ${c.score} — "${c.title}"`);
  }
  for (const f of ['metadata.json', 'transcript.json', 'transcript.srt']) {
    if (!fs.existsSync(path.join(outDir, f))) problems.push(`ausente: ${f}`);
  }
  if (!rendered) problems.push('nenhum corte renderizado');
  if (problems.length) {
    console.error('\nFALHOU:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
  console.log(`\nOK — saída em ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
