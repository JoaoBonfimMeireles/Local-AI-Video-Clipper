import { deleteJob, getJob, listClips, listJobLogs } from '@clipper/shared/server';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = getJob(id);
  if (!job) return Response.json({ error: 'Job não encontrado' }, { status: 404 });
  const after = Number(new URL(req.url).searchParams.get('afterLog') ?? 0) || 0;
  return Response.json({ job, clips: listClips(id), logs: listJobLogs(id, after) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = deleteJob(id);
  return Response.json({ ok }, { status: ok ? 200 : 409 });
}
