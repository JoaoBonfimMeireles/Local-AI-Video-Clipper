import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataPaths, ensureDataDirs, getJob, insertFavorite, isInside, listFavorites, resolveBinary, runProcess } from '@clipper/shared/server';
import { badRequest } from '@/lib/validation';
import { readMemeProject } from '../../../../worker/meme-store';

export const dynamic = 'force-dynamic';

/** SRT -> SBV (formato do YouTube): "h:mm:ss.mmm,h:mm:ss.mmm" sem numeração. */
function srtToSbv(srt: string): string {
  const t = (s: string) => s.replace(/^0?(\d+):(\d\d):(\d\d),(\d{3})$/, (_m, h, m, sec, ms) => `${Number(h)}:${m}:${sec}.${ms}`);
  return srt
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((b) => b.split('\n').filter(Boolean))
    .filter((l) => l.length >= 2)
    .map((l) => {
      const i = l.findIndex((x) => x.includes('-->'));
      const [a, b] = l[i].split('-->').map((x) => t(x.trim()));
      return `${a},${b}\n${l.slice(i + 1).join('\n')}`;
    })
    .join('\n\n');
}

/**
 * Favorita um vídeo editado (compilado do Editor de vídeo ou vídeo do Limpar vídeo): copia vídeo, capa e legendas
 * para data/favorites/<id>, igual aos cortes. O clip.json guarda "editAction" para o botão Editar do favorito.
 */
export async function POST(req: Request) {
  try {
    const body = z.union([z.object({ kind: z.literal('meme'), projectId: z.string() }), z.object({ kind: z.literal('clean'), jobId: z.string().uuid() })]).parse(await req.json());
    let video: string | undefined;
    let jobId: string;
    let title: string;
    let videoName: string;
    let duration = 0;
    let captions: Record<string, string> = {};
    let editAction: { type: 'meme'; url: string } | { type: 'clean'; jobId: string };
    if (body.kind === 'meme') {
      const p = readMemeProject(body.projectId);
      if (!p?.lastRender) return Response.json({ error: 'Renderize o compilado antes de favoritar' }, { status: 409 });
      video = p.lastRender.video;
      jobId = p.lastRender.jobId;
      title = p.title || p.name;
      videoName = p.name;
      captions = p.lastRender.captions ?? {};
      editAction = { type: 'meme', url: `/memes?p=${p.id}` };
    } else {
      const job = getJob(body.jobId);
      video = job?.result?.cleanOutput;
      if (!job?.settings.clean || !video) return Response.json({ error: 'Vídeo limpo não encontrado' }, { status: 404 });
      jobId = job.id;
      videoName = job.settings.clean.file;
      title = `Limpo · ${path.parse(videoName).name}`;
      editAction = { type: 'clean', jobId: job.id };
    }
    if (!video || !isInside(dataPaths.output, video) || !fs.existsSync(video)) return Response.json({ error: 'Arquivo do vídeo não encontrado' }, { status: 404 });
    // Já favoritado (mesmo arquivo)? Devolve o existente
    const existing = listFavorites().find((f) => f.jobId === jobId);
    if (existing) return Response.json({ favorite: existing });

    ensureDataDirs();
    const id = randomUUID();
    const dir = path.join(dataPaths.favorites, id);
    fs.mkdirSync(dir, { recursive: true });
    const videoPath = path.join(dir, 'clip.mp4');
    fs.copyFileSync(video, videoPath);
    // Capa e duração a partir do próprio vídeo
    const ff = resolveBinary('ffmpeg');
    await runProcess(ff, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '4', path.join(dir, 'clip.jpg')], { timeoutMs: 60_000 });
    if (!duration) {
      const pr = await runProcess(resolveBinary('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { timeoutMs: 30_000 });
      duration = Number(pr.stdout.trim()) || 0;
    }
    const subtitles: Record<string, { srt: string; sbv: string }> = {};
    let srtPath: string | null = null;
    for (const [lang, srt] of Object.entries(captions)) {
      if (!srt || !fs.existsSync(srt)) continue;
      const text = fs.readFileSync(srt, 'utf8');
      fs.writeFileSync(path.join(dir, `clip.${lang}.srt`), text, 'utf8');
      fs.writeFileSync(path.join(dir, `clip.${lang}.sbv`), srtToSbv(text), 'utf8');
      subtitles[lang] = { srt: `clip.${lang}.srt`, sbv: `clip.${lang}.sbv` };
      if (!srtPath || lang === 'pt') srtPath = path.join(dir, `clip.${lang}.srt`);
    }
    const metadataPath = path.join(dir, 'clip.json');
    const meta = { title, duration, editAction, favorite: { id, jobId, clipIndex: 0, videoName, favoritedAt: new Date().toISOString() }, files: { video: 'clip.mp4', thumbnail: 'clip.jpg', subtitles } };
    fs.writeFileSync(metadataPath, JSON.stringify(meta, null, 2), 'utf8');
    const favorite = insertFavorite({ id, jobId, clipIndex: 0, videoName, title, description: null, hashtags: [], dir, videoPath, srtPath, metadataPath, duration });
    return Response.json({ favorite }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
