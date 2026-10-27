import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { listClips } from '@clipper/shared/server';
import { probe } from '@clipper/video-processing';
import { compareFrame, targetSize } from '@/lib/enhance-preview';
import { badRequest } from '@/lib/validation';
import { cropPx, enhanceTarget } from '../../../../../../../worker/enhance';

export const dynamic = 'force-dynamic';

const frac = z.coerce.number().finite().min(0).max(1);
const Body = z.object({
  /** Segundo do vídeo ORIGINAL (a prévia do editor pode tocar uma cópia leve; aqui vale o arquivo de verdade). */
  at: z.coerce.number().finite().min(0).max(24 * 3600),
  box: z.object({ x0: frac, y0: frac, x1: frac, y1: frac }).refine((b) => b.x1 - b.x0 > 0.01 && b.y1 - b.y0 > 0.01, 'área pequena demais'),
});

/**
 * Prévia do "Melhorar qualidade" do editor manual: um quadro da área marcada no tamanho que o render usa, em cada
 * versão (original, só aumentar, aumentar + restaurar rostos). Roda na GPU em alguns segundos.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  try {
    const { id, index } = await params;
    const body = Body.parse(await req.json());
    const clip = listClips(id).find((c) => c.index === Number(index));
    if (!clip?.metadataPath || !fs.existsSync(clip.metadataPath)) return Response.json({ error: 'Corte não encontrado' }, { status: 404 });
    const input: string | undefined = JSON.parse(fs.readFileSync(clip.metadataPath, 'utf8')).renderContext?.input;
    if (!input || !fs.existsSync(input)) return Response.json({ error: 'O vídeo original deste corte não está mais em data/input.' }, { status: 409 });
    const info = await probe(input);
    const px = cropPx(body.box, info.width, info.height);
    const size = targetSize(px.w, px.h, enhanceTarget(px.w, px.h));
    const images = await compareFrame({ key: `${path.basename(id)}_${Number(index)}`, input, at: Math.min(body.at, Math.max(0, info.duration - 0.1)), crop: px, ...size });
    return Response.json({ images, ...size, source: { width: px.w, height: px.h } });
  } catch (e) {
    return badRequest(e);
  }
}
