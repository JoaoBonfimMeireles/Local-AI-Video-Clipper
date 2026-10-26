import { z } from 'zod';
import { getJob } from '@clipper/shared/server';
import { badRequest } from '@/lib/validation';
import { readCuriosityAnalysis, writeCuriosityAnalysis } from '../../../../worker/curiosity-store';
import { CuriosityIdeaSchema } from '../schema';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job?.settings.curiosity?.analyze) return Response.json({ error: 'Análise não encontrada' }, { status: 404 });
  return Response.json({ job, analysis: readCuriosityAnalysis(id) });
}

/** Guarda as ideias editadas no painel (trechos, roteiro, ideias criadas à mão). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const a = readCuriosityAnalysis(id);
    if (!a) return Response.json({ error: 'Análise não encontrada' }, { status: 404 });
    const body = z.object({ ideas: z.array(CuriosityIdeaSchema).max(60) }).parse(await req.json());
    writeCuriosityAnalysis({ ...a, ideas: body.ideas });
    return Response.json({ ok: true });
  } catch (e) {
    return badRequest(e);
  }
}
