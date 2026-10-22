import fs from 'node:fs';
import path from 'node:path';
import { dataPaths, ensureDataDirs } from '@clipper/shared/server';
import { VIDEO_EXTENSIONS } from '@/lib/media';

export const dynamic = 'force-dynamic';

export async function GET() {
  ensureDataDirs();
  const files = fs
    .readdirSync(dataPaths.input, { withFileTypes: true })
    .filter((f) => f.isFile() && VIDEO_EXTENSIONS.includes(path.extname(f.name).toLowerCase()))
    .map((f) => {
      const st = fs.statSync(path.join(dataPaths.input, f.name));
      return { name: f.name, size: st.size, modifiedAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return Response.json({ files, dir: dataPaths.input });
}
