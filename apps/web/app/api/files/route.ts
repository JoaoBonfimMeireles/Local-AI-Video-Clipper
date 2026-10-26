import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { dataPaths, isInside } from '@clipper/shared/server';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

/** Serve arquivos de data/output, data/favorites, data/input e da biblioteca (memes/sons/imagens, para a prévia do editor) com suporte a Range. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get('path') ?? '';
  const full = path.resolve(p);
  if (!p || !(isInside(dataPaths.output, full) || isInside(dataPaths.favorites, full) || isInside(dataPaths.input, full) || isInside(path.join(dataPaths.root, 'cache', 'previews'), full) || [dataPaths.memes, dataPaths.audio, dataPaths.images, path.join(dataPaths.root, 'meme-studio')].some((d) => isInside(d, full))) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return new Response('Não encontrado', { status: 404 });
  }
  const ext = path.extname(full).toLowerCase();
  const size = fs.statSync(full).size;
  const headers: Record<string, string> = { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'accept-ranges': 'bytes' };
  if (url.searchParams.has('download')) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(path.basename(full))}"`;

  const range = req.headers.get('range');
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    const stream = Readable.toWeb(fs.createReadStream(full, { start, end })) as unknown as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(full)) as unknown as ReadableStream;
  return new Response(stream, { headers: { ...headers, 'content-length': String(size) } });
}
