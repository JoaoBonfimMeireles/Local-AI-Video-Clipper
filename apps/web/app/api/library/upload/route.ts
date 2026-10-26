import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, libraryBaseDir, MEME_EXTENSIONS, type LibraryKind } from '@clipper/shared/server';

export const dynamic = 'force-dynamic';

const EXTS: Record<LibraryKind, string[]> = { memes: MEME_EXTENSIONS, audio: AUDIO_EXTENSIONS, images: IMAGE_EXTENSIONS };

/** Upload (corpo bruto) de um arquivo para uma pasta da biblioteca. Headers: x-kind, x-folder ("_geral" = raiz), x-file-name. */
export async function PUT(req: Request) {
  const kind = req.headers.get('x-kind') as LibraryKind;
  if (!(kind in EXTS)) return Response.json({ error: 'Tipo inválido' }, { status: 400 });
  const folder = path.basename(decodeURIComponent(req.headers.get('x-folder') ?? '_geral'));
  const parsed = path.parse(path.basename(decodeURIComponent(req.headers.get('x-file-name') ?? '')));
  const ext = parsed.ext.toLowerCase();
  if (!parsed.name || !EXTS[kind].includes(ext)) return Response.json({ error: `Formato não aceito aqui: ${ext || '(nenhum)'} (aceitos: ${EXTS[kind].join(' ')})` }, { status: 400 });
  const dir = folder === '_geral' ? libraryBaseDir(kind) : path.join(libraryBaseDir(kind), folder);
  if (!fs.existsSync(dir) || !req.body) return Response.json({ error: 'Pasta não encontrada' }, { status: 404 });
  const safe = parsed.name.replace(/[^\p{L}\p{N}_\-. ]/gu, '_').slice(0, 120) || 'arquivo';
  let target = path.join(dir, `${safe}${ext}`);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${safe}_${i}${ext}`);
  const tmp = `${target}.uploading`;
  try {
    await pipeline(Readable.fromWeb(req.body as unknown as NodeReadableStream), fs.createWriteStream(tmp));
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return Response.json({ error: `Falha no upload: ${(e as Error).message}` }, { status: 500 });
  }
  return Response.json({ name: path.basename(target) }, { status: 201 });
}
