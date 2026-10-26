import { z } from 'zod';
import { CURIOSITY_TEMPLATES, type CuriosityTemplateKey } from '@clipper/shared';

export const CuriosityIdeaSchema = z.object({
  id: z.string().min(1).max(40),
  template: z.enum(CURIOSITY_TEMPLATES.map((t) => t.key) as [CuriosityTemplateKey, ...CuriosityTemplateKey[]]),
  title: z.string().trim().min(1).max(140),
  hook: z.string().trim().max(200),
  script: z.string().trim().max(2000),
  cta: z.string().trim().max(200),
  segments: z
    .array(z.object({ start: z.number().min(0), end: z.number().min(0), label: z.string().max(60).nullish() }).refine((s) => s.end > s.start + 0.5, 'trecho precisa ter mais de 0,5s'))
    .min(1)
    .max(8),
  score: z.number().min(0).max(100),
  reason: z.string().max(800),
  hashtags: z.array(z.string().max(40)).max(12),
  manual: z.boolean().optional(),
  spoiler: z.boolean().optional(),
});
