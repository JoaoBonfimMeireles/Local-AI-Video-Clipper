import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { UPSCALE_MODEL_IDS } from '@clipper/shared';
import { createJob, dataPaths, getJob, isInside, listClips } from '@clipper/shared/server';
import { badRequest } from '@/lib/validation';

const t = z.coerce.number().finite().min(0).max(24 * 3600);
const frac = z.coerce.number().finite().min(0).max(1);
const name = z.string().trim().min(1).max(200);
const Box = z.object({ x0: frac, y0: frac, x1: frac, y1: frac }).refine((b) => b.x1 - b.x0 > 0.02 && b.y1 - b.y0 > 0.02, 'caixa pequena demais');

const Align = z.object({ x: z.coerce.number().min(0).max(1), y: z.coerce.number().min(0).max(1) });
/** Conteúdo ao lado: só arquivos de data/input ou da biblioteca (imagens/memes). */
const Side = z.object({
  kind: z.enum(['image', 'video', 'scene']),
  file: z
    .string()
    .max(1000)
    .refine((f) => [dataPaths.input, dataPaths.images, dataPaths.memes].some((d) => isInside(d, path.resolve(f))) && fs.existsSync(f), 'Arquivo do conteúdo ao lado não encontrado')
    .optional(),
  start: z.coerce.number().min(0).max(86400).optional(),
  box: Box.optional(),
  side: z.enum(['left', 'right']),
  width: z.coerce.number().min(0.2).max(0.8),
  fit: z.enum(['cover', 'blur']),
  align: Align.optional(),
});

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** Logo: só a do Editor de vídeo (data/meme-studio) ou da biblioteca de imagens/memes. */
const LogoFile = z
  .string()
  .max(1000)
  .refine((f) => [path.join(dataPaths.root, 'meme-studio'), dataPaths.images, dataPaths.memes].some((d) => isInside(d, path.resolve(f))) && fs.existsSync(f), 'Logo não encontrada');

const Style = z.object({ border: z.coerce.number().min(0).max(0.1), color: Color, radius: z.coerce.number().min(0).max(0.5) });

const ManualEditSchema = z.object({
  segments: z.array(z.object({ start: t, end: t, label: z.string().max(60).nullish() })).min(1).max(8),
  shots: z.array(z.object({ at: t, duration: z.coerce.number().min(0.3).max(600), type: z.enum(['focus', 'wide']), focusX: frac, focusY: frac, scale: z.coerce.number().min(1).max(2.5) })).max(80),
  zooms: z.array(z.object({ at: t, duration: z.coerce.number().min(0.3).max(30), scale: z.coerce.number().min(1).max(2), focusX: frac, focusY: frac, target: z.enum(['screen', 'cam']).optional() })).max(80),
  overlays: z
    .array(
      z.object({
        type: z.enum(['meme', 'image']),
        category: name,
        file: name,
        at: t,
        duration: z.coerce.number().min(0.3).max(10),
        position: z.enum(['center', 'top', 'bottom', 'top-left', 'top-right']),
        scale: z.coerce.number().min(0.1).max(1),
        audioMode: z.enum(['meme', 'video', 'both']),
      }),
    )
    .max(30),
  sfx: z.array(z.object({ category: name, file: name, at: t, volume: z.coerce.number().min(0).max(2), duration: z.coerce.number().min(0.3).max(10).optional() })).max(40),
  camZoom: z.coerce.number().min(0.5).max(3).optional(),
  frames: z
    .array(
      z.object({
        at: t,
        end: t,
        mode: z.enum(['single', 'split']),
        fit: z.enum(['cover', 'blur']),
        box: Box,
        box2: Box.optional(),
        topRatio: z.coerce.number().min(0.2).max(0.8).optional(),
        camShape: z.enum(['rect', 'circle']).optional(),
        styleTop: Style.nullable().optional(),
        styleBottom: Style.nullable().optional(),
        bottomRatio: z.coerce.number().min(0.15).max(0.8).optional(),
        enhanceTop: z.enum(UPSCALE_MODEL_IDS).nullable().optional(),
        enhanceBottom: z.enum(UPSCALE_MODEL_IDS).nullable().optional(),
        fitTop: z.enum(['cover', 'blur']).optional(),
        alignTop: Align.optional(),
        alignBottom: Align.optional(),
        sideTop: Side.nullable().optional(),
        sideBottom: Side.nullable().optional(),
      }),
    )
    .max(40)
    .optional(),
  texts: z
    .array(
      z.object({
        text: z.string().max(300),
        at: t.optional(),
        end: t.optional(),
        x: frac,
        y: frac,
        size: z.coerce.number().min(0.02).max(0.3),
        color: Color,
        outline: z.coerce.number().min(0).max(0.3),
        outlineColor: Color,
        box: z.boolean(),
        boxColor: Color,
        boxOpacity: z.coerce.number().min(0).max(1),
      }),
    )
    .max(20)
    .optional(),
  background: Color.nullable().optional(),
  logo: z.object({ file: LogoFile, x: frac, y: frac, size: z.coerce.number().min(0.02).max(0.5) }).nullable().optional(),
});

/** Cria um job de ajuste com a edição MANUAL do corte (sem IA): o worker só renderiza o plano enviado. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; index: string }> }) {
  try {
    const { id, index } = await params;
    const manual = ManualEditSchema.parse(await req.json());
    const parent = getJob(id);
    if (!parent) return Response.json({ error: 'Job não encontrado' }, { status: 404 });
    const clipIndex = Number(index);
    const clip = listClips(id).find((c) => c.index === clipIndex);
    if (!clip || clip.status !== 'completed') return Response.json({ error: 'Corte não encontrado ou ainda não renderizado' }, { status: 409 });
    const job = createJob(parent.inputPath, `Edição manual do corte ${clipIndex + 1} — ${parent.videoName}`.slice(0, 200), {
      ...parent.settings,
      revision: { parentJobId: id, clipIndex, comment: 'Edição manual', manual },
    });
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
