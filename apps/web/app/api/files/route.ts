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
};

/** Serve arquivos de data/output (somente) com suporte a Range para o player de vídeo. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get('path') ?? '';
  const full = path.resolve(p);
  if (!p || !isInside(dataPaths.output, full) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
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
