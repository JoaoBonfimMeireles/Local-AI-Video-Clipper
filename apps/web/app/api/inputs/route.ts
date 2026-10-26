import fs from 'node:fs';
import path from 'node:path';
import { dataPaths, ensureDataDirs, getDb } from '@clipper/shared/server';
import { listMemeProjects } from '../../../worker/meme-store';
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

/** Apaga de vez um vídeo de data/input (libera espaço em disco). */
export async function DELETE(req: Request) {
  const name = path.basename(new URL(req.url).searchParams.get('name') ?? '');
  const file = path.join(dataPaths.input, name);
  if (!name || !fs.existsSync(file) || !fs.statSync(file).isFile()) return Response.json({ error: 'Vídeo não encontrado' }, { status: 404 });
  // Proteção: vídeos usados por cortes/limpezas (o editor manual precisa do original) ou por compilados não saem
  const jobs = getDb().prepare("SELECT video_name FROM jobs WHERE input_path = ? AND status != 'cancelled'").all(file) as { video_name: string }[];
  const memes = listMemeProjects().filter((p) => p.clips.some((c) => c.file === name));
  if (jobs.length || memes.length) {
    const uses = [...jobs.map((j) => `• ${j.video_name}`), ...memes.map((p) => `• compilado "${p.title || p.name}"`)].slice(0, 6).join('\n');
    return Response.json({ error: `Este vídeo ainda é usado e não pode ser apagado:\n${uses}\n\nApague antes esses itens (no Painel ou no Editor de vídeo).` }, { status: 409 });
  }
  try {
    fs.rmSync(file);
  } catch (e) {
    return Response.json({ error: `Não deu para apagar (o vídeo pode estar em uso): ${(e as Error).message}` }, { status: 409 });
  }
  return Response.json({ ok: true });
}
