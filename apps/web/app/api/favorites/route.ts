import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dataPaths, ensureDataDirs, getJob, insertFavorite, listClips, listFavoriteRevisions, listFavorites } from '@clipper/shared/server';
import { badRequest } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

/** Favoritos (filtro opcional pelo dia em que foram favoritados) + o último ajuste pedido em cada um. */
export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const filter = z.object({ from: day, to: day }).parse({ from: sp.get('from') || undefined, to: sp.get('to') || undefined });
    const favorites = listFavorites(filter);
    const revisions: Record<string, { id: string; status: string; step: string; progress: number; comment: string; error: string | null; finishedAt: string | null; createdAt: string }> = {};
    for (const r of listFavoriteRevisions()) {
      const rev = r.settings.revision;
      if (!rev?.favoriteId || revisions[rev.favoriteId]) continue;
      revisions[rev.favoriteId] = { id: r.id, status: r.status, step: r.step, progress: r.progress, comment: rev.comment, error: r.error, finishedAt: r.finishedAt, createdAt: r.createdAt };
    }
    return Response.json({ favorites, revisions });
  } catch (e) {
    return badRequest(e);
  }
}

/**
 * Favorita um corte: COPIA vídeo, capa, SRT, metadados e transcrição para data/favorites/<id>, assim
 * reprocessar ou excluir o job não afeta o favorito.
 */
export async function POST(req: Request) {
  try {
    const { jobId, clipIndex } = z.object({ jobId: z.string().uuid(), clipIndex: z.number().int().min(0) }).parse(await req.json());
    const job = getJob(jobId);
    const clip = listClips(jobId).find((c) => c.index === clipIndex);
    if (!job?.result?.outputDir || !clip?.outputPath || !clip.metadataPath || !fs.existsSync(clip.outputPath)) {
      return Response.json({ error: 'Corte não encontrado ou ainda não renderizado' }, { status: 409 });
    }
    ensureDataDirs();
    const id = randomUUID();
    const dir = path.join(dataPaths.favorites, id);
    fs.mkdirSync(dir, { recursive: true });
    const copy = (src: string | null | undefined, name: string) => {
      if (!src || !fs.existsSync(src)) return null;
      const dst = path.join(dir, name);
      fs.copyFileSync(src, dst);
      return dst;
    };
    const videoPath = copy(clip.outputPath, 'clip.mp4')!;
    copy(clip.outputPath.replace(/\.mp4$/, '.jpg'), 'clip.jpg');
    const srtPath = copy(clip.srtPath, 'clip.srt');
    copy(path.join(job.result.outputDir, 'transcript.json'), 'transcript.json');
    // Metadados apontando para os arquivos da cópia
    const meta = JSON.parse(fs.readFileSync(clip.metadataPath, 'utf8'));
    // Versão com legenda em mandarim e legendas nos 4 idiomas (SRT/SBV)
    const srcDir = path.dirname(clip.metadataPath);
    const videoZh = meta.files?.videoZh ? (copy(path.join(srcDir, meta.files.videoZh), 'clip.zh.mp4') ? 'clip.zh.mp4' : null) : null;
    const subtitles: Record<string, { srt: string; sbv: string }> = {};
    for (const [lang, f] of Object.entries((meta.files?.subtitles ?? {}) as Record<string, { srt: string; sbv: string }>)) {
      const srt = copy(path.join(srcDir, f.srt), `clip.${lang}.srt`);
      const sbv = copy(path.join(srcDir, f.sbv), `clip.${lang}.sbv`);
      if (srt && sbv) subtitles[lang] = { srt: path.basename(srt), sbv: path.basename(sbv) };
    }
    // 3 capas do teste A/B de miniaturas
    const thumbnails = ((meta.files?.thumbnails ?? []) as string[]).map((f, i) => (copy(path.join(srcDir, f), `clip.thumb${i + 1}.jpg`) ? `clip.thumb${i + 1}.jpg` : null)).filter(Boolean);
    meta.favorite = { id, jobId, clipIndex, videoName: job.videoName, favoritedAt: new Date().toISOString() };
    meta.files = { ...(meta.files ?? {}), video: 'clip.mp4', videoZh, thumbnail: 'clip.jpg', thumbnails, srt: srtPath ? { [Object.keys(meta.files?.srt ?? { pt: '' })[0]]: 'clip.srt' } : {}, subtitles };
    const metadataPath = path.join(dir, 'clip.json');
    fs.writeFileSync(metadataPath, JSON.stringify(meta, null, 2), 'utf8');
    const favorite = insertFavorite({
      id,
      jobId,
      clipIndex,
      videoName: job.videoName,
      title: clip.title,
      description: clip.description,
      hashtags: clip.hashtags,
      dir,
      videoPath,
      srtPath,
      metadataPath,
      duration: Number(meta.duration ?? clip.end - clip.start),
    });
    return Response.json({ favorite }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
