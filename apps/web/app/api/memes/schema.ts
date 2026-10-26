import { z } from 'zod';

const T = z.number().min(0).max(36000);
const Frac = z.number().min(-0.5).max(1.5);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const MemeProjectSchema = z.object({
  name: z.string().trim().max(120),
  title: z.string().trim().max(160),
  titleMode: z.enum(['all', 'spans']),
  titleSpans: z.array(z.object({ id: z.string().max(40), at: T, end: T })).max(60),
  clips: z
    .array(
      z
        .object({
          id: z.string().max(40),
          file: z.string().min(1).max(260),
          start: T,
          end: T,
          sourceDuration: T,
          width: z.number().int().min(0).max(10000),
          height: z.number().int().min(0).max(10000),
          hasAudio: z.boolean(),
          volume: z.number().min(0).max(2),
        })
        .refine((c) => c.end > c.start + 0.2, 'trecho precisa ter mais de 0,2s'),
    )
    .max(20),
  images: z.array(z.object({ id: z.string().max(40), file: z.string().min(1).max(500), at: T, duration: z.number().min(0.1).max(3600), x: Frac, y: Frac, w: z.number().min(0.02).max(1.5), aspect: z.number().min(0.05).max(20) })).max(60),
  sfx: z.array(z.object({ id: z.string().max(40), file: z.string().min(1).max(500), at: T, volume: z.number().min(0).max(2), duration: z.number().min(0.1).max(60) })).max(80),
  music: z.object({ file: z.string().min(1).max(500), offset: T, volume: z.number().min(0).max(2) }).nullable(),
  subtitles: z.boolean(),
});
// cues e lastRender ficam fora: quem grava é o worker (o painel só lê)

export const MemeBrandSchema = z.object({
  logo: z.string().max(500).nullable(),
  logoAspect: z.number().min(0.05).max(20),
  background: Color,
  frame: Color,
  titleColor: Color,
  logoPos: z.enum(['top', 'bottom', 'hidden']),
  logoSize: z.number().min(0.03).max(0.25),
  logoStill: z.boolean(),
  titleScale: z.number().min(0.5).max(1.8),
  videoWidth: z.number().min(0.4).max(1),
  showFrame: z.boolean(),
  radius: z.number().min(0).max(0.1),
  offsetY: z.number().min(0).max(0.3),
});
