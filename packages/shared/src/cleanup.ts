// Exclusão completa de um job: além da linha no banco, apaga os cortes gerados, a pasta temporária e os caches que só
// ele usa (transcrição, análise da IA, prévia do painel, trechos baixados da VOD), para liberar espaço em disco.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Job } from './types';
import { dataPaths, isInside } from './paths';
import { getAppSettings, getDb, getJob } from './db';

/** Base dos caches por vídeo (transcrição, conhecimento da IA): mesmo arquivo + modelo + idioma = mesma chave. */
export function videoCacheBase(input: string, model: string, language: string): string {
  const st = fs.statSync(input);
  const key = createHash('sha1').update([path.basename(input), st.size, Math.floor(st.mtimeMs), model, language].join('|')).digest('hex').slice(0, 20);
  return path.join(dataPaths.root, 'cache', 'transcripts', key);
}

/** Chave da versão leve (360p) usada pelo painel do vídeo — mesma regra de api/inputs/preview. */
function previewFile(input: string): string {
  const st = fs.statSync(input);
  const key = createHash('sha1').update(`v2|${path.basename(input)}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('hex').slice(0, 16);
  return path.join(dataPaths.root, 'cache', 'previews', `${key}.mp4`);
}

function sizeOf(p: string): number {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(p).reduce((a, n) => a + sizeOf(path.join(p, n)), 0);
  } catch {
    return 0;
  }
}

/** Todos os jobs, inclusive os ajustes de corte (que a lista principal esconde). */
function allJobs(): Job[] {
  const ids = getDb().prepare('SELECT id FROM jobs').all() as { id: string }[];
  return ids.map((r) => getJob(r.id)).filter((j): j is Job => !!j);
}

/**
 * Exclui o job, os ajustes feitos nos cortes dele e tudo o que eles geraram. Nunca apaga o vídeo que você colocou em
 * data/input nem os favoritos (que são cópias independentes); caches compartilhados com outro job ficam.
 */
export function purgeJob(id: string): { ok: boolean; freedBytes: number; warnings: string[] } {
  const job = getJob(id);
  if (!job || job.status === 'processing') return { ok: false, freedBytes: 0, warnings: [] };
  const all = allJobs();
  const children = all.filter((j) => j.settings.revision?.parentJobId === id);
  if (children.some((j) => j.status === 'processing')) return { ok: false, freedBytes: 0, warnings: ['Um ajuste deste job está rodando; espere terminar.'] };
  const gone = new Set([id, ...children.map((j) => j.id)]);
  const others = all.filter((j) => !gone.has(j.id));
  let freedBytes = 0;
  const warnings: string[] = [];
  /** Remove dentro de data/ (e só lá); falha no Windows (arquivo em uso) vira aviso, não erro. */
  const rm = (p: string | null | undefined) => {
    if (!p || !isInside(dataPaths.root, p) || !fs.existsSync(p)) return;
    const size = sizeOf(p);
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      freedBytes += size;
    } catch (e) {
      warnings.push(`${path.basename(p)}: ${(e as Error).message}`);
    }
  };

  for (const jid of gone) rm(path.join(dataPaths.temp, jid));
  // Pasta de saída (cortes, capas, legendas): só a do próprio job — ajustes gravam dentro da pasta do pai
  const out = job.result?.outputDir;
  if (out && !job.settings.revision && isInside(dataPaths.output, out) && !others.some((o) => o.result?.outputDir === out)) rm(out);
  rm(job.result?.cleanOutput);
  // VOD da Twitch: análise e trechos baixados (o arquivo de entrada foi gerado pelo app)
  const vodId = job.result?.vodId ?? job.settings.vodSource?.vodId;
  if (vodId && /^[\w-]+$/.test(vodId) && !others.some((o) => (o.result?.vodId ?? o.settings.vodSource?.vodId) === vodId)) rm(path.join(dataPaths.root, 'vods', vodId));
  // Caches do vídeo de entrada, se nenhum outro job usa o mesmo arquivo
  const input = job.inputPath;
  if (input && !job.settings.revision && fs.existsSync(input) && fs.statSync(input).isFile() && !others.some((o) => o.inputPath === input)) {
    const base = videoCacheBase(input, getAppSettings().whisperModel, job.settings.sourceLanguage);
    const dir = path.dirname(base);
    if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) if (n.startsWith(path.basename(base))) rm(path.join(dir, n));
    rm(previewFile(input));
    if (job.settings.vodSource && !isInside(dataPaths.input, input)) rm(input);
  }
  const del = getDb().prepare("DELETE FROM jobs WHERE id = ? AND status != 'processing'");
  for (const c of children) del.run(c.id);
  const ok = del.run(id).changes > 0;
  return { ok, freedBytes, warnings };
}
