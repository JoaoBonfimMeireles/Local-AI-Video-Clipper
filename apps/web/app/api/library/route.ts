import fs from 'node:fs';
import { dataPaths, resolveLibraryFile, scanLibrary, type LibraryKind } from '@clipper/shared/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ library: scanLibrary(), dirs: { memes: dataPaths.memes, audio: dataPaths.audio, images: dataPaths.images } });
}

/** Apaga um arquivo da biblioteca (só se ele estiver no índice). */
export async function DELETE(req: Request) {
  const q = new URL(req.url).searchParams;
  const kind = q.get('kind') as LibraryKind;
  if (!['memes', 'audio', 'images'].includes(kind)) return Response.json({ error: 'Tipo inválido' }, { status: 400 });
  const file = resolveLibraryFile(scanLibrary(), kind, q.get('folder') ?? '', q.get('file') ?? '');
  if (!file) return Response.json({ error: 'Arquivo não encontrado' }, { status: 404 });
  fs.rmSync(file, { force: true });
  return Response.json({ ok: true });
}
