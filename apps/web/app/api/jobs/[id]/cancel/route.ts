import { addJobLog, cancelJob } from '@clipper/shared/server';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = cancelJob(id);
  if (ok) addJobLog(id, 'warn', 'Cancelamento solicitado pelo usuário');
  return Response.json({ ok }, { status: ok ? 200 : 409 });
}
