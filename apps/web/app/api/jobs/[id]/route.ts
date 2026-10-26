import { purgeJob, getJob, listClips, listJobLogs, listRevisions } from '@clipper/shared/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return Response.json({ error: 'Job não encontrado' }, { status: 404 });
  const after = Number(new URL(req.url).searchParams.get('afterLog') ?? 0) || 0;
  // Último ajuste de cada corte (status/progresso), para o card do corte mostrar "ajustando…" e "atualizado"
  const revisions: Record<number, { id: string; status: string; step: string; progress: number; comment: string; error: string | null; finishedAt: string | null; createdAt: string }> = {};
  for (const r of listRevisions(id)) {
    const rev = r.settings.revision!;
    // Ajustes de favoritos mexem só na cópia do favorito, não no corte deste job
    if (rev.favoriteId || revisions[rev.clipIndex]) continue;
    revisions[rev.clipIndex] = { id: r.id, status: r.status, step: r.step, progress: r.progress, comment: rev.comment, error: r.error, finishedAt: r.finishedAt, createdAt: r.createdAt };
  }
  return Response.json({ job, clips: listClips(id), logs: listJobLogs(id, after), revisions });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Apaga tudo do job (cortes, temporários e caches só dele) para liberar espaço
  const r = purgeJob(id);
  return Response.json(r, { status: r.ok ? 200 : 409 });
}
