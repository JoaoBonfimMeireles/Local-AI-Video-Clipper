import { z } from 'zod';
import { createJob, getJob } from '@clipper/shared/server';
import { badRequest, JobSettingsSchema } from '@/lib/validation';
import { readCuriosityAnalysis } from '../../../../../worker/curiosity-store';
import { CuriosityIdeaSchema } from '../../schema';

/** Renderiza as ideias aprovadas: um job normal do pipeline, com os trechos já definidos e o narrador opcional. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const source = getJob(id);
    const a = readCuriosityAnalysis(id);
    if (!source || !a) return Response.json({ error: 'Análise não encontrada' }, { status: 404 });
    const body = z.object({ ideas: z.array(CuriosityIdeaSchema).min(1).max(20), narrator: z.boolean(), settings: JobSettingsSchema }).parse(await req.json());
    const ideas = body.ideas.map((idea) => ({ ...idea, segments: idea.segments.map((sg) => ({ ...sg, end: Math.min(sg.end, a.duration) })) }));
    const job = createJob(source.inputPath, `${source.videoName} · curiosidades`, {
      ...body.settings,
      mode: 'youtube',
      reference: null,
      range: null,
      maxClips: ideas.length,
      // Mesmo idioma da análise: reaproveita a transcrição em cache
      sourceLanguage: source.settings.sourceLanguage,
      curiosity: { ideas, narrator: body.narrator, sourceJobId: id },
    });
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
