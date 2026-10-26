import fs from 'node:fs';
import path from 'node:path';
import { dataPaths, safeJoin } from '@clipper/shared/server';
import { probeAsset } from '@clipper/video-processing';

export const dynamic = 'force-dynamic';

/** Duração, tamanho e áudio de um vídeo de data/input (para montar o compilado). */
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get('file') ?? '';
  const full = safeJoin(dataPaths.input, path.basename(name));
  if (!name || !fs.existsSync(full)) return Response.json({ error: 'Arquivo não encontrado em data/input' }, { status: 404 });
  return Response.json({ path: full, ...(await probeAsset(full)) });
}
