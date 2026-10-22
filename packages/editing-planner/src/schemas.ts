import { z } from 'zod';

/** Nome de categoria (pasta): sem barras, pontos ou caracteres de caminho. */
export const SafeName = z.string().trim().regex(/^[\p{L}\p{N}_\- ]{1,64}$/u, 'nome de categoria inválido');
/** Nome de arquivo simples: sem separadores de pasta nem "..". Ainda assim só é aceito se existir no índice da biblioteca. */
export const SafeFileName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((n) => !/[\\/:*?"<>|\0]/.test(n) && !n.includes('..'), 'nome de arquivo inválido');

const Seconds = z.coerce.number().finite().min(0).max(24 * 3600);

// ---------- Etapa 4: seleção de cortes ----------

export const ClipCandidateSchema = z
  .object({
    start: Seconds,
    end: Seconds,
    score: z.coerce.number().finite().min(0).max(100),
    title: z.string().trim().min(1).max(140),
    reason: z.string().trim().max(800).default(''),
    hook: z.string().trim().max(300).optional(),
  })
  .refine((c) => c.end > c.start + 2, { message: 'end deve ser maior que start (mín. 2s)' });

export const CandidateListSchema = z.object({
  clips: z.array(ClipCandidateSchema).max(60),
});

// ---------- Etapa 5: plano de edição ----------

export const OverlayPositionSchema = z.enum(['center', 'top', 'bottom', 'top-left', 'top-right']);

export const ZoomSchema = z.object({
  at: Seconds,
  duration: z.coerce.number().finite().min(0.2).max(30),
  scale: z.coerce.number().finite().min(1).max(2),
  focusX: z.coerce.number().finite().min(0).max(1).default(0.5),
  focusY: z.coerce.number().finite().min(0).max(1).default(0.4),
});

export const OverlaySchema = z.object({
  type: z.enum(['meme', 'image']).default('meme'),
  category: SafeName,
  file: SafeFileName.optional().nullable(),
  at: Seconds,
  duration: z.coerce.number().finite().min(0.3).max(10),
  position: OverlayPositionSchema.default('top'),
  scale: z.coerce.number().finite().min(0.1).max(1).default(0.5),
});

export const SfxSchema = z.object({
  category: SafeName,
  file: SafeFileName.optional().nullable(),
  at: Seconds,
  volume: z.coerce.number().finite().min(0).max(2).default(0.8),
});

export const ClipEditSchema = z.object({
  clipIndex: z.coerce.number().int().min(0),
  zooms: z.array(ZoomSchema).max(80).default([]),
  overlays: z.array(OverlaySchema).max(30).default([]),
  sfx: z.array(SfxSchema).max(40).default([]),
  emphasisWords: z.array(z.string().trim().min(1).max(40)).max(60).default([]),
});

export const EditPlanSchema = z.object({
  clips: z.array(ClipEditSchema).max(60),
});

// ---------- Tradução ----------

export const TranslationSchema = z.object({
  translations: z.array(z.object({ id: z.coerce.number().int(), text: z.string().max(2000) })),
});

export type ClipCandidateInput = z.infer<typeof ClipCandidateSchema>;
export type Zoom = z.infer<typeof ZoomSchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
export type Sfx = z.infer<typeof SfxSchema>;
export type ClipEdit = z.infer<typeof ClipEditSchema>;
export type EditPlan = z.infer<typeof EditPlanSchema>;

/** Extrai o primeiro objeto JSON de uma resposta de LLM (tolera ```json e texto extra). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const first = body.search(/[{[]/);
    if (first < 0) throw new Error('Resposta da IA sem JSON');
    const open = body[first];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    for (let i = first; i < body.length; i++) {
      const ch = body[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) return JSON.parse(body.slice(first, i + 1));
    }
    throw new Error('JSON incompleto na resposta da IA');
  }
}

/** Valida com Zod e devolve mensagem de erro curta (útil para pedir correção à IA). */
export function parseWith<T>(schema: z.ZodType<T>, raw: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    error: r.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; '),
  };
}
