import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { dataPaths, ensureDataDirs } from '@clipper/shared/server';
import { VIDEO_EXTENSIONS } from '@/lib/media';

export const dynamic = 'force-dynamic';

/** Upload em streaming (corpo bruto) direto para data/input — suporta arquivos de vários GB sem usar RAM. */
export async function PUT(req: Request) {
  const raw = decodeURIComponent(req.headers.get('x-file-name') ?? '');
  const parsed = path.parse(path.basename(raw));
  const ext = parsed.ext.toLowerCase();
  if (!parsed.name || !VIDEO_EXTENSIONS.includes(ext)) {
    return Response.json({ error: `Extensão não suportada: ${ext || '(nenhuma)'}` }, { status: 400 });
  }
  if (!req.body) return Response.json({ error: 'Corpo vazio' }, { status: 400 });
  ensureDataDirs();
  const safeName = parsed.name.replace(/[^\p{L}\p{N}_\-. ]/gu, '_').slice(0, 120) || 'video';
  let target = path.join(dataPaths.input, `${safeName}${ext}`);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dataPaths.input, `${safeName}_${i}${ext}`);
  const tmp = `${target}.uploading`;
  try {
    await pipeline(Readable.fromWeb(req.body as unknown as NodeReadableStream), fs.createWriteStream(tmp));
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return Response.json({ error: `Falha no upload: ${(e as Error).message}` }, { status: 500 });
  }
  return Response.json({ name: path.basename(target), size: fs.statSync(target).size }, { status: 201 });
}
