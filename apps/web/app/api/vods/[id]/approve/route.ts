import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { JobSettings } from '@clipper/shared';
import { createJob, dataPaths } from '@clipper/shared/server';
import { badRequest } from '@/lib/validation';
import { VOD_SECTION_MARGIN } from '../../../../../worker/twitch-vod';

/**
 * Aprovação dos momentos de um VOD: cria o job de cortes. O worker baixa só esses trechos (com margem),
 * junta num arquivo de data/input e segue o pipeline normal (transcrição, IA, edição, render).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!/^\d{6,12}$/.test(id)) return badRequest(new Error('VOD inválido'));
    const { ranks } = z.object({ ranks: z.array(z.coerce.number().int().min(1)).min(1).max(30) }).parse(await req.json());
    const file = path.join(dataPaths.root, 'vods', id, 'peaks.json');
    if (!fs.existsSync(file)) return badRequest(new Error('Este VOD ainda não foi analisado.'));
    const peaks = JSON.parse(fs.readFileSync(file, 'utf8'));
    const chosen = (peaks.moments as { rank: number; start: number; end: number; typeLabel: string }[]).filter((m) => ranks.includes(m.rank));
    if (!chosen.length) return badRequest(new Error('Nenhum momento marcado.'));

    // Trechos em ordem cronológica, com margem; vizinhos que se encostam viram um só
    const sections: { start: number; end: number; label: string }[] = [];
    for (const m of [...chosen].sort((a, b) => a.start - b.start)) {
      const start = Math.max(0, m.start - VOD_SECTION_MARGIN);
      const end = Math.min(peaks.meta.duration, m.end + VOD_SECTION_MARGIN);
      const last = sections.at(-1);
      if (last && start <= last.end + 2) last.end = Math.max(last.end, end);
      else sections.push({ start, end, label: `#${m.rank} ${m.typeLabel}` });
    }
    const key = createHash('sha1').update(JSON.stringify(sections)).digest('hex').slice(0, 6);
    const slug = String(peaks.meta.channel || 'twitch').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
    const input = path.join(dataPaths.input, `twitch_${slug}_${id}_${key}.mp4`);
    const settings: JobSettings = { ...(peaks.settings as JobSettings), mode: 'twitch', range: null, vodAnalysis: null, vodSource: { vodId: id, url: peaks.meta.url, sections } };
    const job = createJob(input, `${peaks.meta.channel} — ${peaks.meta.title} (${chosen.length} momentos)`.slice(0, 200), settings);
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
