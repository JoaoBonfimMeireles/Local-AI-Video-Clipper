import { addJobLog, retryJob } from '@clipper/shared/server';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = retryJob(id);
  if (ok) addJobLog(id, 'info', 'Job reenviado para a fila');
  return Response.json({ ok }, { status: ok ? 200 : 409 });
}
