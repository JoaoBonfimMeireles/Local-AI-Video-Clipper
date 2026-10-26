import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MemeProject } from '@clipper/shared';
import { dataPaths, listJobs } from '@clipper/shared/server';
import { badRequest } from '@/lib/validation';
import { listMemeProjects, readMemeBrand, readMemeProject, writeMemeProject } from '../../../worker/meme-store';

export const dynamic = 'force-dynamic';

/** Projetos de compilado, a identidade do canal e os jobs (legendas/render) do painel de memes. */
export async function GET() {
  const jobs = listJobs(200).filter((j) => j.settings.meme);
  return Response.json({ inputDir: dataPaths.input, projects: listMemeProjects(), brand: readMemeBrand(), jobs });
}

export async function POST(req: Request) {
  try {
    const body = z.object({ name: z.string().trim().max(120).default(''), copyOf: z.string().optional() }).parse(await req.json().catch(() => ({})));
    const now = new Date().toISOString();
    // Duplicar: mesma edição (vídeos, imagens, sons, legendas) num projeto novo, sem o render antigo
    if (body.copyOf) {
      const src = readMemeProject(body.copyOf);
      if (!src) return Response.json({ error: 'Projeto não encontrado' }, { status: 404 });
      const copy: MemeProject = { ...src, id: randomUUID(), name: `${src.name} (cópia)`, title: src.title ? `${src.title} (cópia)` : "", lastRender: null, createdAt: now, updatedAt: now };
      writeMemeProject(copy);
      return Response.json({ project: copy }, { status: 201 });
    }
    const p: MemeProject = {
      id: randomUUID(),
      name: body.name || `Compilado ${new Date().toLocaleDateString('pt-BR')}`,
      title: '',
      titleMode: 'all',
      titleSpans: [],
      clips: [],
      images: [],
      sfx: [],
      music: null,
      subtitles: true,
      cues: {},
      createdAt: now,
      updatedAt: now,
    };
    writeMemeProject(p);
    return Response.json({ project: p }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
