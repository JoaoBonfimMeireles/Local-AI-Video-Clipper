import fs from 'node:fs';
import path from 'node:path';
import { narratorSprites } from '../../../worker/narrator';

export const dynamic = 'force-dynamic';

/** Sprite do narrador para a prévia do painel (mesmo arquivo usado no render): ?m=0..2 (boca) &e=0..1 (olhos). */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const m = Math.min(2, Math.max(0, Number(q.get('m')) || 0));
  const e = q.get('e') === '1' ? 1 : 0;
  try {
    const file = path.join(await narratorSprites(), `m${m}_e${e}.png`);
    return new Response(fs.readFileSync(file), { headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
