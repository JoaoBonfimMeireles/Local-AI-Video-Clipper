import { z } from 'zod';
import { DEFAULT_JOB_SETTINGS } from '@clipper/shared';
import { createJob, dataPaths, safeJoin } from '@clipper/shared/server';
import { badRequest } from '@/lib/validation';
import { readMemeProject } from '../../../../../worker/meme-store';

export const dynamic = 'force-dynamic';

/** Enfileira a transcrição das falas (legendas) ou o render do compilado. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const p = readMemeProject((await params).id);
    if (!p) return Response.json({ error: 'Projeto não encontrado' }, { status: 404 });
    if (!p.clips.length) return badRequest(new Error('Adicione pelo menos um vídeo ao compilado'));
    const body = z.object({ action: z.enum(['transcribe', 'render']), sourceLanguage: z.string().regex(/^(auto|[a-z]{2,3})$/).default('auto') }).parse(await req.json());
    const job = createJob(safeJoin(dataPaths.input, p.clips[0].file), `${body.action === 'render' ? 'Memes' : 'Legendas'} · ${p.title || p.name}`, {
      ...DEFAULT_JOB_SETTINGS,
      sourceLanguage: body.sourceLanguage,
      meme: { projectId: p.id, action: body.action },
    });
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
