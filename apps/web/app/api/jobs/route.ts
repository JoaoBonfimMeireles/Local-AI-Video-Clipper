import fs from 'node:fs';
import path from 'node:path';
import { createJob, dataPaths, listJobs, safeJoin } from '@clipper/shared/server';
import { badRequest, CreateJobSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ jobs: listJobs(100) });
}

export async function POST(req: Request) {
  try {
    const body = CreateJobSchema.parse(await req.json());
    // Apenas arquivos dentro de data/input são aceitos
    const input = safeJoin(dataPaths.input, path.basename(body.inputFile));
    if (!fs.existsSync(input) || !fs.statSync(input).isFile()) return badRequest(new Error('Arquivo não encontrado em data/input'));
    // Corte de referência também só de data/input (e diferente do original)
    if (body.settings.reference) {
      const ref = safeJoin(dataPaths.input, path.basename(body.settings.reference.clipFile));
      if (!fs.existsSync(ref) || !fs.statSync(ref).isFile()) return badRequest(new Error('Corte de referência não encontrado em data/input'));
      if (ref === input) return badRequest(new Error('O corte de referência e o vídeo original precisam ser arquivos diferentes'));
      body.settings.reference.clipFile = path.basename(ref);
    }
    const job = createJob(input, path.parse(input).name, body.settings);
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
