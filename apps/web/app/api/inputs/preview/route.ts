import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataPaths, isInside, resolveBinary, runProcess } from '@clipper/shared/server';

export const dynamic = 'force-dynamic';

/** Remuxes em andamento (evita dois ffmpeg para o mesmo arquivo). */
const pending = new Map<string, Promise<void>>();

/**
 * Caminho de um vídeo de entrada que o navegador consegue tocar no painel de seleção. Downloads de live costumam
 * ser MPEG-TS com extensão .mp4 (o navegador não toca): nesse caso gera, uma vez, uma versão leve em MP4 (360p,
 * mesmos tempos e proporção) em data/cache/previews.
 */
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get('name') ?? '';
  const file = path.join(dataPaths.input, path.basename(name));
  if (!name || !isInside(dataPaths.input, file) || !fs.existsSync(file)) return Response.json({ error: 'Vídeo não encontrado' }, { status: 404 });
  const probe = await runProcess(resolveBinary('ffprobe'), ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', file], { timeoutMs: 30_000 });
  if (/mp4|mov/.test(probe.stdout) && /\.(mp4|m4v|mov)$/i.test(file)) return Response.json({ path: file, remuxed: false });

  const st = fs.statSync(file);
  const key = createHash('sha1').update(`v2|${path.basename(file)}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('hex').slice(0, 16);
  const dir = path.join(dataPaths.root, 'cache', 'previews');
  const out = path.join(dir, `${key}.mp4`);
  if (!fs.existsSync(out)) {
    let job = pending.get(key);
    if (!job) {
      fs.mkdirSync(dir, { recursive: true });
      // Temporário único por processo: duas gerações simultâneas (ex.: recarga do servidor no meio) não se corrompem
      const tmp = path.join(dir, `${key}.${process.pid}-${Date.now()}.tmp.mp4`);
      // Versão leve (360p, quadro-chave a cada 2s) só para assistir/marcar no painel: tempos e proporção iguais
      // ao original. Copiar o contêiner não basta: lives da Twitch têm saltos de tempo que o navegador não decodifica.
      const enc = (codec: string[]) =>
        runProcess(
          resolveBinary('ffmpeg'),
          ['-y', '-loglevel', 'error', '-fflags', '+genpts', '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=-2:360', ...codec, '-g', '60', '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-movflags', '+faststart', tmp],
          { timeoutMs: 30 * 60_000 },
        );
      job = enc(['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', '32'])
        .then((r) => (r.code === 0 ? r : enc(['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30'])))
        .then((r) => {
          if (r.code !== 0) throw new Error(r.stderrTail);
          if (!fs.existsSync(out)) fs.renameSync(tmp, out);
          else fs.rmSync(tmp, { force: true });
        })
        .finally(() => pending.delete(key));
      pending.set(key, job);
    }
    try {
      await job;
    } catch (e) {
      return Response.json({ error: `Não foi possível preparar a prévia: ${(e as Error).message.slice(0, 300)}` }, { status: 500 });
    }
  }
  return Response.json({ path: out, remuxed: true });
}
