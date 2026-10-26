// Worker local persistente: consome a fila de jobs do SQLite, um por vez (GPU/CPU intensivo).
// Roda em processo separado do Next.js para nunca travar a interface HTTP.
import fs from 'node:fs';
import path from 'node:path';
import {
  addJobLog,
  claimNextJob,
  dataPaths,
  finishJob,
  getDb,
  getJobStatus,
  getRepoRoot,
  loadRootEnv,
  requeueStaleJobs,
  runProcess,
} from '@clipper/shared/server';
import { runCleanJob } from './clean';
import { runCuriosityAnalysis } from './curiosity';
import { runMemeJob } from './meme';
import { runPipeline } from './pipeline';
import { runReferenceJob } from './references';
import { runRevision } from './revise';
import { prepareVodSource, runVodAnalysis } from './twitch-vod';

loadRootEnv();
const POLL_MS = Number(process.env.WORKER_POLL_MS) || 2000;
let stopping = false;
let current: AbortController | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Remove pastas temporárias de jobs concluídos ou já excluídos (sobras de limpezas que falharam). */
function cleanOrphanTemp() {
  if (!fs.existsSync(dataPaths.temp)) return;
  for (const name of fs.readdirSync(dataPaths.temp)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) continue;
    const status = getJobStatus(name);
    if (status === null || status === 'completed') {
      try {
        fs.rmSync(path.join(dataPaths.temp, name), { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* tenta de novo na próxima inicialização */
      }
    }
  }
}

/**
 * Se o worker anterior foi morto abruptamente, seus filhos (Python/FFmpeg) podem continuar rodando
 * e ocupando GPU/CPU. Encerra processos cujo comando aponta para scripts/pastas deste projeto.
 */
async function killOrphanProcesses() {
  if (process.platform !== 'win32') return;
  const markers = [path.join(getRepoRoot(), 'packages', 'ai-providers', 'python'), dataPaths.root];
  const ps = `Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='ffmpeg.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`;
  try {
    const res = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 20_000 });
    const pids = res.stdout
      .split(/\r?\n/)
      .map((l) => l.split('|'))
      .filter(([pid, cmd]) => pid && cmd && Number(pid) !== process.pid && markers.some((m) => cmd.toLowerCase().includes(m.toLowerCase())))
      .map(([pid]) => pid);
    for (const pid of pids) await runProcess('taskkill', ['/pid', pid, '/T', '/F'], { timeoutMs: 10_000 }).catch(() => undefined);
    if (pids.length) console.log(`[worker] ${pids.length} processo(s) órfão(s) encerrado(s)`);
  } catch {
    /* melhor esforço */
  }
}

async function main() {
  getDb();
  await killOrphanProcesses();
  cleanOrphanTemp();
  const requeued = requeueStaleJobs();
  console.log(`[worker] iniciado (poll ${POLL_MS}ms)${requeued ? ` — ${requeued} job(s) interrompido(s) voltaram para a fila` : ''}`);

  while (!stopping) {
    const job = claimNextJob();
    if (!job) {
      await sleep(POLL_MS);
      continue;
    }
    console.log(`[worker] job ${job.id} — ${job.videoName} (tentativa ${job.attempts})`);
    addJobLog(job.id, 'info', `Worker iniciou o processamento (tentativa ${job.attempts})`);
    const ac = new AbortController();
    current = ac;
    const watcher = setInterval(() => {
      if (getJobStatus(job.id) === 'cancelled') ac.abort(new Error('cancelado pelo usuário'));
    }, 1500);
    const t0 = Date.now();
    try {
      // Análise de VOD da Twitch: não renderiza cortes, só acha os momentos para revisão
      if (job.settings.vodAnalysis) {
        const vodId = await runVodAnalysis(job, ac.signal);
        finishJob(job.id, 'completed');
        addJobLog(job.id, 'info', `Análise do VOD ${vodId} concluída em ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        continue;
      }
      // Curiosidades: só transcreve e gera a galeria de ideias (o render vem depois, com as ideias aprovadas)
      if (job.settings.curiosity?.analyze) {
        const n = await runCuriosityAnalysis(job, ac.signal);
        finishJob(job.id, 'completed');
        addJobLog(job.id, 'info', `Ideias de curiosidade geradas (${n}) em ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        continue;
      }
      // Cortes de VOD: baixa só os trechos aprovados antes do pipeline normal
      if (job.settings.vodSource) await prepareVodSource(job, ac.signal);
      const { rendered, failed } = job.settings.clean
        ? await runCleanJob(job, ac.signal)
        : job.settings.meme
        ? await runMemeJob(job, ac.signal)
        : job.settings.analyzeReferences
        ? await runReferenceJob(job, ac.signal)
        : job.settings.revision
          ? await runRevision(job, ac.signal)
          : await runPipeline(job, ac.signal);
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      if (rendered === 0) {
        finishJob(job.id, 'failed', `Nenhum corte foi renderizado (${failed} falha(s)).`);
        addJobLog(job.id, 'error', `Job falhou: todos os ${failed} cortes falharam`);
      } else {
        finishJob(job.id, 'completed');
        addJobLog(job.id, failed ? 'warn' : 'info', `Concluído em ${secs}s: ${rendered} corte(s) renderizado(s)${failed ? `, ${failed} com falha` : ''}`);
      }
    } catch (e) {
      if (ac.signal.aborted && stopping) {
        addJobLog(job.id, 'warn', 'Worker encerrado durante o processamento; o job será retomado na próxima inicialização');
      } else if (ac.signal.aborted) {
        addJobLog(job.id, 'warn', 'Job cancelado pelo usuário');
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[worker] job ${job.id} falhou:`, e);
        addJobLog(job.id, 'error', `Falha: ${msg}`);
        finishJob(job.id, 'failed', msg.slice(0, 2000));
      }
    } finally {
      clearInterval(watcher);
      current = null;
    }
  }
}

function shutdown() {
  if (stopping) process.exit(0);
  stopping = true;
  console.log('[worker] encerrando...');
  current?.abort(new Error('worker encerrado'));
  // jobs interrompidos ficam 'processing' e voltam à fila (requeueStaleJobs) no próximo start
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  console.error('[worker] erro fatal:', e);
  process.exit(1);
});
