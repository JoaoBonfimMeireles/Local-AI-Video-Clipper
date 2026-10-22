import { createJob, dataPaths, ensureDataDirs } from '@clipper/shared/server';
import { DEFAULT_JOB_SETTINGS } from '@clipper/shared';
import { cachedStyleGuide, listReferences } from '../../../worker/references';

export const dynamic = 'force-dynamic';

/** Clipes de referência, se já foram analisados, e o guia de estilo atual. */
export async function GET() {
  ensureDataDirs();
  const refs = listReferences().map((r) => ({ name: r.name, analyzed: r.analyzed, niche: r.style?.niche ?? null, stats: r.stats ?? null }));
  return Response.json({ dir: dataPaths.references, references: refs, guide: cachedStyleGuide() });
}

/** Enfileira a análise das referências novas (job sem vídeo de entrada). */
export async function POST() {
  if (!listReferences().length) return Response.json({ error: `Coloque clipes em ${dataPaths.references} primeiro` }, { status: 400 });
  const job = createJob(dataPaths.references, 'Análise dos clipes de referência', { ...DEFAULT_JOB_SETTINGS, analyzeReferences: true });
  return Response.json({ job }, { status: 201 });
}
