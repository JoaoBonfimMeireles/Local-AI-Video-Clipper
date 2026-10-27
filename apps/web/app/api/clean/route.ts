import fs from 'node:fs';
import { z } from 'zod';
import { DEFAULT_JOB_SETTINGS, UPSCALE_MODEL_IDS } from '@clipper/shared';
import { createJob, dataPaths, deleteJob, getJob, isInside, listJobs, safeJoin } from '@clipper/shared/server';
import { badRequest } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const range = z.object({ start: z.number().min(0), end: z.number().min(0) });
const box = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.005).max(1), h: z.number().min(0.005).max(1) });
const schema = z.object({
  file: z.string().min(1),
  cuts: z.array(range).max(500),
  trimSilence: z.boolean(),
  minSilence: z.number().min(0.3).max(10),
  removeMusic: z.boolean(),
  removeSubtitles: z.boolean(),
  subtitleBand: z.object({ y: z.number().min(0).max(1), h: z.number().min(0.02).max(1) }).nullable(),
  logos: z.array(box).max(10),
  cropBlackBars: z.boolean(),
  denoise: z.boolean(),
  normalizeAudio: z.boolean(),
  exportStems: z.boolean().default(false),
  upscaleTo: z.union([z.literal(0), z.literal(480), z.literal(720), z.literal(1080)]).default(0),
  upscaleModel: z.enum(UPSCALE_MODEL_IDS).default('realistic'),
});

/** Limpezas recentes (jobs com settings.clean). */
export async function GET() {
  const jobs = listJobs(200).filter((j) => j.settings.clean).slice(0, 30);
  return Response.json({ jobs, inputDir: dataPaths.input });
}

/** Enfileira a limpeza de um vídeo de data/input. */
export async function POST(req: Request) {
  try {
    const spec = schema.parse(await req.json());
    const input = safeJoin(dataPaths.input, spec.file);
    if (!fs.existsSync(input)) return Response.json({ error: 'Vídeo não encontrado em data/input' }, { status: 404 });
    const job = createJob(input, `Limpar · ${spec.file}`, { ...DEFAULT_JOB_SETTINGS, clean: spec });
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}

/** Apaga uma limpeza do histórico e o vídeo limpo gerado (a cópia levada ao editor fica em data/input). */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  const job = getJob(id);
  if (!job?.settings.clean) return Response.json({ error: 'Limpeza não encontrada' }, { status: 404 });
  if (job.status === 'processing') return Response.json({ error: 'Cancele ou espere terminar antes de apagar' }, { status: 409 });
  const out = job.result?.cleanOutput;
  for (const f of [out, ...Object.values(job.result?.cleanStems ?? {})]) if (f && isInside(dataPaths.output, f)) fs.rmSync(f, { force: true });
  deleteJob(id);
  return Response.json({ ok: true });
}
