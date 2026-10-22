import { z } from 'zod';
import { createJob, getJob, listClips } from '@clipper/shared/server';
import { badRequest } from '@/lib/validation';

/** Cria um job de AJUSTE que refaz só este corte a partir do comentário do editor. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  try {
    const { id, index } = await params;
    const { comment } = z.object({ comment: z.string().trim().min(3).max(2000) }).parse(await req.json());
    const parent = getJob(id);
    if (!parent) return Response.json({ error: 'Job não encontrado' }, { status: 404 });
    const clipIndex = Number(index);
    const clip = listClips(id).find((c) => c.index === clipIndex);
    if (!clip || clip.status !== 'completed') return Response.json({ error: 'Corte não encontrado ou ainda não renderizado' }, { status: 409 });
    const job = createJob(parent.inputPath, `Ajuste do corte ${clipIndex + 1} — ${parent.videoName}`.slice(0, 200), {
      ...parent.settings,
      revision: { parentJobId: id, clipIndex, comment },
    });
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
