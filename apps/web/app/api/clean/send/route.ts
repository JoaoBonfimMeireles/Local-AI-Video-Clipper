import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { dataPaths, getJob, isInside } from '@clipper/shared/server';
import { badRequest } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** "Levar para o editor": copia o vídeo limpo para data/input (onde o editor escolhe os vídeos). */
export async function POST(req: Request) {
  try {
    const { jobId } = z.object({ jobId: z.string().uuid() }).parse(await req.json());
    const out = getJob(jobId)?.result?.cleanOutput;
    if (!out || !isInside(dataPaths.output, out) || !fs.existsSync(out)) return Response.json({ error: 'Vídeo limpo não encontrado' }, { status: 404 });
    const name = path.basename(out);
    const target = path.join(dataPaths.input, name);
    if (!fs.existsSync(target)) fs.copyFileSync(out, target);
    return Response.json({ name });
  } catch (e) {
    return badRequest(e);
  }
}
