import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CURIOSITY_TEMPLATES, type CuriosityTemplateKey } from '@clipper/shared';
import { createJob, dataPaths, listJobs, safeJoin } from '@clipper/shared/server';
import { badRequest, JobSettingsSchema } from '@/lib/validation';
import { readCuriosityAnalysis } from '../../../worker/curiosity-store';

export const dynamic = 'force-dynamic';

const TemplateKey = z.enum(CURIOSITY_TEMPLATES.map((t) => t.key) as [CuriosityTemplateKey, ...CuriosityTemplateKey[]]);

/** Vídeos-fonte já analisados (ou em análise) para o canal de curiosidades, com as ideias de cada um. */
export async function GET() {
  const sources = listJobs(200)
    .filter((j) => j.settings.curiosity?.analyze)
    .map((job) => {
      const a = job.status === 'completed' ? readCuriosityAnalysis(job.id) : null;
      return { job, ideas: a?.ideas.length ?? 0, summary: a?.summary ?? '' };
    });
  const renders = listJobs(200).filter((j) => j.settings.curiosity?.ideas?.length);
  return Response.json({ sources, renders });
}

/** Cria o job que transcreve o vídeo-fonte e gera as ideias pelos formatos escolhidos (sem renderizar). */
export async function POST(req: Request) {
  try {
    const body = z
      .object({
        inputFile: z.string().min(1).max(260),
        templates: z.array(TemplateKey).min(1).max(CURIOSITY_TEMPLATES.length),
        count: z.coerce.number().int().min(1).max(20),
        topic: z.string().trim().max(300).default(''),
        targetSeconds: z.union([z.literal(30), z.literal(60)]).default(60),
        settings: JobSettingsSchema,
      })
      .parse(await req.json());
    const input = safeJoin(dataPaths.input, path.basename(body.inputFile));
    if (!fs.existsSync(input) || !fs.statSync(input).isFile()) return badRequest(new Error('Arquivo não encontrado em data/input'));
    const job = createJob(input, path.parse(input).name, {
      ...body.settings,
      mode: 'youtube',
      reference: null,
      curiosity: { analyze: { templates: body.templates, count: body.count, topic: body.topic, targetSeconds: body.targetSeconds } },
    });
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
