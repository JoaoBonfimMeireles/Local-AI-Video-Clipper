import { z } from 'zod';

/** Nome de categoria (pasta): sem barras, pontos ou caracteres de caminho. */
export const SafeName = z.string().trim().regex(/^[\p{L}\p{N}_\- ]{1,64}$/u, 'nome de categoria inválido');

/** Texto livre da IA: corta o excesso em vez de recusar (evita repetir uma chamada paga só por ficar longo). */
const cappedText = (max: number, min = 0) => z.string().trim().min(min).transform((s) => s.slice(0, max));
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
  .object({
    start: Seconds,
    end: Seconds,
    /** Título curto do momento (usado nos cartões numerados do Top 5). */
    label: cappedText(60).nullish(),
  })
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
    /** Formato da faixa de ouro: "loop" (15-20s, fecha no gancho) ou "story" (20-40s, desfecho seco). */
    shortFormat: z.enum(['loop', 'story']).nullish().catch(null),
    score: z.coerce.number().finite().min(0).max(100),
    title: cappedText(140, 1),
    reason: cappedText(800).default(''),
    hook: cappedText(300).optional(),
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
  reason: cappedText(300).optional(),
});

export const SfxSchema = z.object({
  // Com o catálogo por códigos (m12, s3) a categoria vem do próprio catálogo; a IA pode omiti-la
  category: SafeName.default('_geral'),
  file: SafeFileName.optional().nullable(),
  at: Seconds,
  volume: z.coerce.number().finite().min(0).max(2).default(0.8),
  /** Quanto do som tocar (s). Sons longos são cortados com fade para não virarem trilha de fundo. */
  duration: z.coerce.number().finite().min(0.3).max(10).optional(),
  reason: cappedText(300).optional(),
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
  reason: cappedText(200).optional(),
  /** Preenchido localmente (detecção de rosto), não pela IA: caixa do rosto enquadrado. */
  subject: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional(),
  /** Preenchido localmente: faixa horizontal (0-1) que contém todas as pessoas, para planos abertos. */
  group: z.object({ x0: z.number(), x1: z.number() }).nullable().optional(),
});

/**
 * Imagem ilustrativa do que está sendo falado (tempos relativos ao corte). A IA só descreve a busca;
 * o app procura a imagem em bancos de licença livre e trata o visual (recorte/cartão).
 */
export const IllustrationSchema = z.object({
  at: Seconds,
  duration: z.coerce.number().finite().min(1).max(6).default(2.5),
  /** Termos de busca em inglês, curtos e concretos ("commercial airplane", "Interstellar"). */
  query: cappedText(80, 2),
  /** Nome em português, para log e créditos. */
  label: cappedText(60).default(''),
  kind: z.enum(['object', 'animal', 'place', 'person', 'brand', 'movie', 'series', 'game', 'food', 'other']).catch('other'),
  position: OverlayPositionSchema.default('top'),
  reason: cappedText(200).optional(),
});
export type Illustration = z.infer<typeof IllustrationSchema>;

export const ClipEditSchema = z.object({
  clipIndex: z.coerce.number().int().min(0),
  illustrations: z.array(IllustrationSchema).transform((a) => a.slice(0, 8)).default([]),
  shots: z.array(ShotSchema).max(80).default([]),
  zooms: z.array(ZoomSchema).max(80).default([]),
  overlays: z.array(OverlaySchema).max(30).default([]),
  sfx: z.array(SfxSchema).max(40).default([]),
  emphasisWords: z.array(cappedText(40, 1)).transform((a) => a.slice(0, 60)).default([]),
  /** Título final para postagem (o modelo de edição pode melhorar o da seleção). */
  title: cappedText(120, 1).optional(),
  /** Legenda/descrição para o post. */
  description: cappedText(1500).optional(),
  /** Texto curto para a capa (thumbnail) do Short. */
  coverText: cappedText(80).nullish(),
  /** Tags do YouTube (SEO): palavras-chave sem #, no máximo ~480 caracteres somados (limite do YouTube é 500). */
  tags: z
    .array(cappedText(80, 1))
    .max(40)
    .default([])
    .transform((tags) => {
      const out: string[] = [];
      const seen = new Set<string>();
      let total = 0;
      for (const raw of tags) {
        const t = raw.replace(/^#+/, '').replace(/[<>,]/g, ' ').replace(/\s+/g, ' ').trim();
        const k = t.toLowerCase();
        if (!t || seen.has(k) || total + t.length + 1 > 480) continue;
        seen.add(k);
        out.push(t);
        total += t.length + 1;
      }
      return out;
    }),
  /** 3 capas diferentes para o teste A/B de miniaturas do YouTube: momento do corte (s) + texto exagerado. */
  thumbnails: z
    .array(z.object({ at: z.coerce.number().min(0), text: cappedText(60, 1) }))
    .transform((a) => a.slice(0, 3))
    .default([]),
  hashtags: z
    .array(cappedText(60, 1))
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
  summary: cappedText(3000),
  format: cappedText(300).default(''),
  speakers: z
    .array(z.object({ id: cappedText(20), description: cappedText(300), position: cappedText(100).default('') }))
    .max(12)
    .default([]),
  topics: z.array(cappedText(80)).transform((a) => a.slice(0, 30)).default([]),
  moments: z
    .array(
      z.object({
        start: Seconds,
        end: Seconds,
        type: z.string().trim().max(30).default('other'),
        description: cappedText(500),
        // A IA às vezes manda null nos campos opcionais: aceitar evita uma chamada extra de correção
        quote: cappedText(400).nullish(),
        speaker: z.string().trim().max(20).nullish(),
        topic: cappedText(80).nullish(),
        strength: z.coerce.number().finite().min(0).max(100).default(50),
        visual: cappedText(300).nullish(),
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

// ---------- Ajuste de um corte pronto (comentário do editor) ----------

/** Resposta da IA ao pedido de ajuste: o plano completo revisado e, se pedido, novos trechos. */
export const RevisionSchema = ClipEditSchema.omit({ clipIndex: true }).extend({
  /** Só quando o pedido muda o começo/fim/trechos do corte (tempos ABSOLUTOS do vídeo original). */
  segments: z.array(SegmentSchema).min(1).max(8).nullish(),
  /** O que foi mudado, em uma frase (vai para o log). */
  changes: cappedText(400).optional(),
});
export type Revision = z.infer<typeof RevisionSchema>;

// ---------- Clipes de referência (estilo aprendido de cortes virais) ----------

export const ReferenceStyleSchema = z.object({
  niche: cappedText(200).default(''),
  hook: cappedText(600),
  structure: cappedText(800),
  pacing: cappedText(600),
  humor: cappedText(600).default(''),
  editing: cappedText(800),
  captions: cappedText(400).default(''),
  ending: cappedText(400).default(''),
  tips: z.array(cappedText(240)).transform((t) => t.slice(0, 8)).default([]),
});
export type ReferenceStyle = z.infer<typeof ReferenceStyleSchema>;

export const StyleGuideSchema = z.object({
  guide: cappedText(4000, 20),
});
