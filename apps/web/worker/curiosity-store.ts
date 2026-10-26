// Galeria de ideias de curiosidade de cada vídeo-fonte (data/curiosities/<jobId>.json). Leve: usado pelo worker e pela API.
import fs from 'node:fs';
import path from 'node:path';
import type { CuriosityAnalysis } from '@clipper/shared';
import { dataPaths } from '@clipper/shared/server';

export const curiosityFile = (jobId: string) => path.join(dataPaths.root, 'curiosities', `${path.basename(jobId)}.json`);

export function readCuriosityAnalysis(jobId: string): CuriosityAnalysis | null {
  const f = curiosityFile(jobId);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as CuriosityAnalysis) : null;
}

export function writeCuriosityAnalysis(a: CuriosityAnalysis): void {
  fs.mkdirSync(path.dirname(curiosityFile(a.jobId)), { recursive: true });
  fs.writeFileSync(curiosityFile(a.jobId), JSON.stringify(a, null, 2), 'utf8');
}
