import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg } from '@clipper/video-processing';
import { badRequest } from '@/lib/validation';
import { memeDir, writeMemeBrand } from '../../../../worker/meme-store';
import { MemeBrandSchema } from '../schema';

export const dynamic = 'force-dynamic';

/** Identidade do canal (logo, cores e medidas do molde), guardada para os próximos vídeos. */
export async function PUT(req: Request) {
  try {
    const body = MemeBrandSchema.parse(await req.json());
    // Logo parada: primeiro quadro da animação (GIF/APNG com quadros cortados ficam estranhos em loop)
    let logoStillFile: string | null = null;
    if (body.logo && body.logoStill && fs.existsSync(body.logo)) {
      const st = fs.statSync(body.logo);
      logoStillFile = path.join(memeDir(), 'cache', `${path.parse(body.logo).name}_${st.size}_still.png`);
      if (!fs.existsSync(logoStillFile)) {
        fs.mkdirSync(path.dirname(logoStillFile), { recursive: true });
        await runFfmpeg(['-i', body.logo, '-frames:v', '1', logoStillFile]);
      }
    }
    const brand = { ...body, logoStillFile };
    writeMemeBrand(brand);
    return Response.json({ brand });
  } catch (e) {
    return badRequest(e);
  }
}
