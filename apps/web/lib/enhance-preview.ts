// Prévia do "Melhorar qualidade" (Limpar vídeo e editor manual): um quadro do vídeo original, na resolução final,
// em cada versão (original, só aumentar, + rostos, detalhado, detalhado + rostos). Só no servidor (rotas da API).
import fs from 'node:fs';
import path from 'node:path';
import type { UpscaleModel } from '@clipper/shared';
import { dataPaths } from '@clipper/shared/server';
import { enhanceCompare, runFfmpeg, sec } from '@clipper/video-processing';

export const COMPARE_MODELS: UpscaleModel[] = ['realistic', 'faces', 'detailed', 'detailedFaces'];
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Tamanho final com o lado menor = target, mantendo a proporção. */
export function targetSize(w: number, h: number, target: number) {
  const k = target / Math.min(w, h);
  return { width: even(w * k), height: even(h * k) };
}

export async function compareFrame(opts: {
  /** Pasta da prévia (só a mais recente fica). */
  key: string;
  input: string;
  at: number;
  crop?: { x: number; y: number; w: number; h: number } | null;
  width: number;
  height: number;
  models?: UpscaleModel[];
}) {
  const dir = path.join(dataPaths.root, 'cache', 'previews', 'enhance', opts.key);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    try {
      fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      /* em uso (Windows): fica para a próxima */
    }
  }
  const frame = path.join(dir, `frame_${Date.now()}.png`);
  const c = opts.crop;
  await runFfmpeg(['-ss', sec(opts.at), '-i', opts.input, '-frames:v', '1', ...(c ? ['-vf', `crop=${c.w}:${c.h}:${c.x}:${c.y}`] : []), frame]);
  if (!fs.existsSync(frame)) throw new Error('Não deu para tirar um quadro desse momento do vídeo.');
  return enhanceCompare({ frame, outDir: dir, width: opts.width, height: opts.height, models: opts.models ?? COMPARE_MODELS });
}
