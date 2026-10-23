import { z } from 'zod';
import { createJob, getFavorite, getJob } from '@clipper/shared/server';
import { DEFAULT_JOB_SETTINGS } from '@clipper/shared';
import { badRequest } from '@/lib/validation';
import fs from 'node:fs';

/** Ajuste por comentário num favorito: refaz só a cópia do favorito (o corte do job não muda). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { comment } = z.object({ comment: z.string().trim().min(3).max(2000) }).parse(await req.json());
    const fav = getFavorite(id);
    if (!fav) return Response.json({ error: 'Favorito não encontrado' }, { status: 404 });
    const meta = JSON.parse(fs.readFileSync(fav.metadataPath, 'utf8'));
    const input: string | undefined = meta.renderContext?.input;
    if (!input) return Response.json({ error: 'Este corte não tem contexto de renderização (versão antiga); não dá para ajustar.' }, { status: 409 });
    // Configurações do job de origem (se ainda existir) ou as padrão
    const settings = getJob(fav.jobId)?.settings ?? DEFAULT_JOB_SETTINGS;
    const job = createJob(input, `Ajuste do favorito — ${fav.title}`.slice(0, 200), {
      ...settings,
      revision: { parentJobId: fav.jobId, clipIndex: fav.clipIndex, comment, favoriteId: fav.id },
    });
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
