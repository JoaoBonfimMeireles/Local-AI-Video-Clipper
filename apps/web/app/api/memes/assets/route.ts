import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { dataPaths, isInside } from '@clipper/shared/server';
import { VIDEO_EXTENSIONS } from '@/lib/media';
import { memeAssetsDir } from '../../../../worker/meme-store';

export const dynamic = 'force-dynamic';

const IMAGE = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const AUDIO = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
const kindOf = (f: string) => {
  const ext = path.extname(f).toLowerCase();
  return IMAGE.includes(ext) ? 'image' : AUDIO.includes(ext) ? 'audio' : VIDEO_EXTENSIONS.includes(ext) ? 'video' : null;
};

function walk(dir: string, depth = 2): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (depth > 0 ? walk(path.join(dir, e.name), depth - 1) : []) : [path.join(dir, e.name)]));
}

/** Imagens e sons disponíveis: os enviados no painel de memes + a biblioteca (data/memes, data/images, data/audio). */
export async function GET() {
  const files = [memeAssetsDir(), dataPaths.images, dataPaths.memes, dataPaths.audio]
    .flatMap((d) => walk(d))
    .map((f) => ({ path: f, name: path.basename(f), folder: path.basename(path.dirname(f)), kind: kindOf(f), uploaded: isInside(memeAssetsDir(), f) }))
    .filter((f) => f.kind === 'image' || f.kind === 'audio');
  return Response.json({ files });
}

/** Upload (corpo bruto) de logo, imagem, música ou efeito sonoro para data/meme-studio/assets. */
export async function PUT(req: Request) {
  const raw = decodeURIComponent(req.headers.get('x-file-name') ?? '');
  const parsed = path.parse(path.basename(raw));
  if (!parsed.name || !kindOf(raw)) return Response.json({ error: `Extensão não suportada: ${parsed.ext || '(nenhuma)'}` }, { status: 400 });
  if (!req.body) return Response.json({ error: 'Corpo vazio' }, { status: 400 });
  fs.mkdirSync(memeAssetsDir(), { recursive: true });
  const safe = parsed.name.replace(/[^\p{L}\p{N}_\-. ]/gu, '_').slice(0, 100) || 'arquivo';
  const ext = parsed.ext.toLowerCase();
  let target = path.join(memeAssetsDir(), `${safe}${ext}`);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(memeAssetsDir(), `${safe}_${i}${ext}`);
  try {
    await pipeline(Readable.fromWeb(req.body as unknown as NodeReadableStream), fs.createWriteStream(target));
  } catch (e) {
    fs.rmSync(target, { force: true });
    return Response.json({ error: `Falha no upload: ${(e as Error).message}` }, { status: 500 });
  }
  return Response.json({ path: target, name: path.basename(target), kind: kindOf(target) }, { status: 201 });
}
