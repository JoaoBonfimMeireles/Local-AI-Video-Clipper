import { z } from 'zod';
import { createJob } from '@clipper/shared/server';
import { badRequest, JobSettingsSchema } from '@/lib/validation';
import { parseVodUrl } from '../../../worker/twitch-vod';

/** Cria o job que analisa um VOD da Twitch pela URL (chat + áudio; o vídeo só é baixado depois da aprovação). */
export async function POST(req: Request) {
  try {
    const body = z.object({ url: z.string().trim().min(5).max(300), settings: JobSettingsSchema }).parse(await req.json());
    const id = parseVodUrl(body.url);
    if (!id) return badRequest(new Error('URL inválida. Use o link de um VOD, como https://www.twitch.tv/videos/123456789'));
    const url = `https://www.twitch.tv/videos/${id}`;
    const job = createJob(url, `VOD da Twitch ${id}`, { ...body.settings, mode: 'twitch', range: null, vodAnalysis: { url } });
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
