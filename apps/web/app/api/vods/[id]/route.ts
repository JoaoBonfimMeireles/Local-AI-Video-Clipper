import fs from 'node:fs';
import path from 'node:path';
import { dataPaths } from '@clipper/shared/server';

export const dynamic = 'force-dynamic';

/** Resultado da análise de um VOD da Twitch (data/vods/<id>/peaks.json), para a tela de revisão. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{6,12}$/.test(id)) return Response.json({ error: 'VOD inválido' }, { status: 400 });
  const file = path.join(dataPaths.root, 'vods', id, 'peaks.json');
  if (!fs.existsSync(file)) return Response.json({ error: 'Este VOD ainda não foi analisado.' }, { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}
