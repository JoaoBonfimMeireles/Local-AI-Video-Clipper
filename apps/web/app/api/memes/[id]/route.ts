import { badRequest } from '@/lib/validation';
import { deleteMemeProject, readMemeProject, writeMemeProject } from '../../../../worker/meme-store';
import { MemeProjectSchema } from '../schema';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = readMemeProject((await params).id);
  return p ? Response.json({ project: p }) : Response.json({ error: 'Projeto não encontrado' }, { status: 404 });
}

/** Guarda a edição (o painel salva sozinho a cada mudança). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const p = readMemeProject((await params).id);
    if (!p) return Response.json({ error: 'Projeto não encontrado' }, { status: 404 });
    const body = MemeProjectSchema.parse(await req.json());
    const next = { ...p, ...body, updatedAt: new Date().toISOString() };
    writeMemeProject(next);
    return Response.json({ project: next });
  } catch (e) {
    return badRequest(e);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return Response.json({ ok: deleteMemeProject((await params).id) });
}
