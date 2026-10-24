import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataPaths, getAppSettings, getJob, listClips, resolveBinary, runProcess } from '@clipper/shared/server';
import { runFfmpeg } from '@clipper/video-processing';

export const dynamic = 'force-dynamic';

/** Margem antes/depois dos trechos: dá para "começar antes / terminar depois" na prévia. */
const PAD = 45;
const pending = new Map<string, Promise<void>>();

/** O navegador só toca MP4/MOV com H.264 (VODs da Twitch costumam ser MPEG-TS com extensão .mp4). */
async function browserPlayable(file: string): Promise<boolean> {
  const r = await runProcess(resolveBinary('ffprobe'), ['-v', 'error', '-show_entries', 'format=format_name:stream=codec_name,codec_type', '-of', 'json', file], { timeoutMs: 30_000 });
  try {
    const j = JSON.parse(r.stdout);
    const video = (j.streams ?? []).find((s: any) => s.codec_type === 'video');
    return /mp4|mov/.test(j.format?.format_name ?? '') && /^(h264|vp9|av1)$/.test(video?.codec_name ?? '');
  } catch {
    return false;
  }
}

/**
 * Vídeo que o editor manual usa na prévia ao vivo: o original, se o navegador tocar; senão uma cópia leve
 * (540p) só da parte da live que o corte usa, feita uma vez e guardada em cache. `offset` = segundo do
 * original em que a cópia começa.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await params;
  const job = getJob(id);
  const clip = job ? listClips(id).find((c) => c.index === Number(index)) : null;
  if (!clip?.metadataPath || !fs.existsSync(clip.metadataPath)) return Response.json({ error: 'Corte não encontrado' }, { status: 404 });
  const meta = JSON.parse(fs.readFileSync(clip.metadataPath, 'utf8'));
  const input: string | undefined = meta.renderContext?.input;
  if (!input || !fs.existsSync(input)) return Response.json({ error: 'Vídeo original não encontrado' }, { status: 404 });
  if (await browserPlayable(input)) return Response.json({ path: input, offset: 0 });

  const segs: { start: number; end: number }[] = meta.renderContext.segments ?? [];
  const start = Math.max(0, Math.floor(Math.min(...segs.map((s) => s.start)) - PAD));
  const end = Math.ceil(Math.max(...segs.map((s) => s.end)) + PAD);
  const key = createHash('sha1').update(`${input}|${fs.statSync(input).size}|${start}|${end}`).digest('hex').slice(0, 16);
  const out = path.join(dataPaths.root, 'cache', 'previews', `editor_${key}.mp4`);
  if (!fs.existsSync(out)) {
    let p = pending.get(key);
    if (!p) {
      p = (async () => {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        // Temporário próprio: com o servidor reiniciando, dois processos podem gerar a mesma prévia ao mesmo tempo
        const tmp = `${out}.${process.pid}.${Date.now()}.tmp.mp4`;
        const nvenc = getAppSettings().hwAccel === 'nvenc';
        const enc = nvenc ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', '30'] : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30'];
        // -ss antes do -i com recodificação = corte exato (o tempo da prévia bate com o do original)
        await runFfmpeg(['-ss', String(start), '-to', String(end), '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=-2:540', ...enc, '-g', '30', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', tmp]);
        fs.renameSync(tmp, out);
      })().finally(() => pending.delete(key));
      pending.set(key, p);
    }
    try {
      await p;
    } catch (e) {
      return Response.json({ error: `Não consegui preparar a prévia: ${(e as Error).message.slice(-300)}` }, { status: 500 });
    }
  }
  return Response.json({ path: out, offset: start });
}
