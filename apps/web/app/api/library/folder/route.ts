import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { libraryBaseDir } from '@clipper/shared/server';
import { badRequest } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** Cria uma pasta (categoria) nova em memes, áudios ou imagens. */
export async function POST(req: Request) {
  try {
    const { kind, name } = z.object({ kind: z.enum(['memes', 'audio', 'images']), name: z.string().trim().min(1).max(60) }).parse(await req.json());
    const safe = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '');
    if (!safe || safe === '_geral') return badRequest(new Error('Nome de pasta inválido'));
    const dir = path.join(libraryBaseDir(kind), safe);
    if (fs.existsSync(dir)) return Response.json({ error: 'Essa pasta já existe' }, { status: 409 });
    fs.mkdirSync(dir, { recursive: true });
    return Response.json({ name: safe }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
