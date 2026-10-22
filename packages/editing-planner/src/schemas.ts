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

export const SegmentSchema = z
  .object({ start: Seconds, end: Seconds })
  .refine((s) => s.end > s.start + 1, { message: 'cada trecho precisa ter end > start (mín. 1s)' });

/**
 * Um corte pode ser um trecho contínuo (start/end) ou a junção de até 4 trechos do vídeo
 * (segments), na ordem em que devem aparecer — ex.: a conclusão no início como gancho.
 */
export const ClipCandidateSchema = z
  .object({
    start: Seconds.optional(),
    end: Seconds.optional(),
    segments: z.array(SegmentSchema).max(8).optional(),
    /** Modo Twitch: categoria do corte (funny, scary, top5...). */
    category: z.string().trim().max(30).optional(),
    score: z.coerce.number().finite().min(0).max(100),
    title: z.string().trim().min(1).max(140),
    reason: z.string().trim().max(800).default(''),
    hook: z.string().trim().max(300).optional(),
  })
  .refine((c) => (c.segments?.length ?? 0) > 0 || (c.start !== undefined && c.end !== undefined && c.end > c.start + 2), {
    message: 'informe segments ou start/end (end > start)',
  })
  .transform((c) => {
    const segments = c.segments?.length ? c.segments : [{ start: c.start!, end: c.end! }];
    return { ...c, segments, start: Math.min(...segments.map((x) => x.start)), end: Math.max(...segments.map((x) => x.end)) };
  });

/** Modelos às vezes devolvem a lista direto (`[...]`) em vez de `{"chave":[...]}`: aceita os dois. */
const wrapArray = (key: string) => (v: unknown) => (Array.isArray(v) ? { [key]: v } : v);

export const CandidateListSchema = z.preprocess(
  wrapArray('clips'),
  z.object({
    clips: z.array(ClipCandidateSchema).max(60),
  }),
);

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
  // Com o catálogo por códigos (m12, s3) a categoria vem do próprio catálogo; a IA pode omiti-la
  category: SafeName.default('_geral'),
  file: SafeFileName.optional().nullable(),
  at: Seconds,
  duration: z.coerce.number().finite().min(0.3).max(10),
  position: OverlayPositionSchema.default('top'),
  scale: z.coerce.number().finite().min(0.1).max(1).default(0.5),
  /**
   * Áudio quando o meme tem som: meme = só o som do meme (vídeo mudo nesse trecho); video = meme mudo,
   * fica a fala do corte; both = os dois, com o vídeo abaixado.
   */
  audioMode: z.enum(['meme', 'video', 'both']).default('both'),
  /** Por que este meme combina com o momento (validação da própria IA). */
  reason: z.string().trim().max(300).optional(),
});

export const SfxSchema = z.object({
  // Com o catálogo por códigos (m12, s3) a categoria vem do próprio catálogo; a IA pode omiti-la
  category: SafeName.default('_geral'),
  file: SafeFileName.optional().nullable(),
  at: Seconds,
  volume: z.coerce.number().finite().min(0).max(2).default(0.8),
  /** Quanto do som tocar (s). Sons longos são cortados com fade para não virarem trilha de fundo. */
  duration: z.coerce.number().finite().min(0.3).max(10).optional(),
  reason: z.string().trim().max(300).optional(),
});

/**
 * Enquadramento (tempos relativos ao corte). focus: recorta uma janela do vídeo original centrada em
 * focusX/focusY (scale 1 = altura inteira; >1 aproxima, ex.: comida). wide: mostra o quadro inteiro
 * (todas as pessoas), com fundo desfocado nos formatos verticais.
 */
export const ShotSchema = z.object({
  at: Seconds,
  duration: z.coerce.number().finite().min(0.5).max(120),
  type: z.enum(['focus', 'wide']).default('focus'),
  focusX: z.coerce.number().finite().min(0).max(1).default(0.5),
  focusY: z.coerce.number().finite().min(0).max(1).default(0.45),
  scale: z.coerce.number().finite().min(1).max(2.5).default(1),
  reason: z.string().trim().max(200).optional(),
  /** Preenchido localmente (detecção de rosto), não pela IA: caixa do rosto enquadrado. */
  subject: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional(),
  /** Preenchido localmente: faixa horizontal (0-1) que contém todas as pessoas, para planos abertos. */
  group: z.object({ x0: z.number(), x1: z.number() }).nullable().optional(),
});

export const ClipEditSchema = z.object({
  clipIndex: z.coerce.number().int().min(0),
  shots: z.array(ShotSchema).max(80).default([]),
  zooms: z.array(ZoomSchema).max(80).default([]),
  overlays: z.array(OverlaySchema).max(30).default([]),
  sfx: z.array(SfxSchema).max(40).default([]),
  emphasisWords: z.array(z.string().trim().min(1).max(40)).max(60).default([]),
  /** Título final para postagem (o modelo de edição pode melhorar o da seleção). */
  title: z.string().trim().min(1).max(120).optional(),
  /** Legenda/descrição para o post. */
  description: z.string().trim().max(1500).optional(),
  hashtags: z
    .array(z.string().trim().min(1).max(60))
    .max(20)
    .default([])
    .transform((tags) => [...new Set(tags.map((t) => '#' + t.replace(/^#+/, '').replace(/\s+/g, '')))].filter((t) => t.length > 1)),
});

export const EditPlanSchema = z.preprocess(
  wrapArray('clips'),
  z.object({
    clips: z.array(ClipEditSchema).max(60),
  }),
);

// ---------- Conhecimento do vídeo (cacheado por vídeo, independente da edição) ----------

export const VideoKnowledgeSchema = z.object({
  summary: z.string().trim().max(3000),
  format: z.string().trim().max(300).default(''),
  speakers: z
    .array(z.object({ id: z.string().trim().max(20), description: z.string().trim().max(300), position: z.string().trim().max(100).default('') }))
    .max(12)
    .default([]),
  topics: z.array(z.string().trim().max(80)).max(30).default([]),
  moments: z
    .array(
      z.object({
        start: Seconds,
        end: Seconds,
        type: z.string().trim().max(30).default('other'),
        description: z.string().trim().max(500),
        quote: z.string().trim().max(400).optional(),
        speaker: z.string().trim().max(20).optional(),
        topic: z.string().trim().max(80).optional(),
        strength: z.coerce.number().finite().min(0).max(100).default(50),
        visual: z.string().trim().max(300).optional(),
      }),
    )
    .max(200),
});

// ---------- Tradução ----------

export const TranslationSchema = z.preprocess(
  wrapArray('translations'),
  z.object({
    translations: z.array(z.object({ id: z.coerce.number().int(), text: z.string().max(2000) })),
  }),
);

export type ClipCandidateInput = z.infer<typeof ClipCandidateSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type VideoKnowledge = z.infer<typeof VideoKnowledgeSchema>;
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
