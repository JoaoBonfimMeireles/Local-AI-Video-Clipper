import fs from 'node:fs';
import { z } from 'zod';
import { dataPaths, safeJoin } from '@clipper/shared/server';
import { probe } from '@clipper/video-processing';
import { compareFrame, targetSize } from '@/lib/enhance-preview';
import { badRequest } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const Body = z.object({
  file: z.string().min(1).max(500),
  at: z.coerce.number().finite().min(0).max(24 * 3600),
  target: z.union([z.literal(480), z.literal(720), z.literal(1080)]),
});

/** Limpar vídeo: antes de iniciar, um quadro do momento atual na resolução escolhida, em cada versão do "Melhorar qualidade". */
export async function POST(req: Request) {
  try {
    const body = Body.parse(await req.json());
    const input = safeJoin(dataPaths.input, body.file);
    if (!fs.existsSync(input)) return Response.json({ error: 'Vídeo não encontrado em data/input' }, { status: 404 });
    const info = await probe(input);
    if (Math.min(info.width, info.height) >= body.target) {
      return Response.json({ error: `O vídeo já tem ${info.width}x${info.height} (≥ ${body.target}p): não há o que aumentar nessa resolução.` }, { status: 409 });
    }
    const size = targetSize(info.width, info.height, body.target);
    const images = await compareFrame({ key: 'limpar', input, at: Math.min(body.at, Math.max(0, info.duration - 0.1)), ...size });
    return Response.json({ images, ...size, source: { width: info.width, height: info.height } });
  } catch (e) {
    return badRequest(e);
  }
}
