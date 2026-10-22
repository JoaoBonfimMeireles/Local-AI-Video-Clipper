import { deletePreset } from '@clipper/shared/server';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = deletePreset(id);
  return Response.json({ ok }, { status: ok ? 200 : 409 });
}
