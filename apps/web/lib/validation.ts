import { z } from 'zod';

const Lang = z.string().regex(/^(auto|[a-z]{2,3})$/);
const Frac = z.number().min(0).max(1);
const FrameBox = z
  .object({ x0: Frac, y0: Frac, x1: Frac, y1: Frac })
  .refine((b) => b.x1 - b.x0 >= 0.02 && b.y1 - b.y0 >= 0.02, 'área muito pequena');

export const JobSettingsSchema = z.object({
  targetDuration: z.coerce.number().int().min(10).max(600),
  maxClips: z.union([z.literal('auto'), z.coerce.number().int().min(1).max(50)]),
  intensity: z.enum(['low', 'medium', 'high']),
  format: z.enum(['original', 'vertical_blur', 'vertical_crop', 'square']),
  sourceLanguage: Lang,
  translateTo: z.union([z.literal(''), z.string().regex(/^[a-z]{2,3}$/)]),
  burnSubtitles: z.boolean(),
  exportSrt: z.boolean(),
  removeOldSubtitles: z.boolean(),
  useMemes: z.boolean(),
  useSfx: z.boolean(),
  mode: z.enum(['youtube', 'twitch']).default('youtube'),
  twitchCategories: z.array(z.enum(['funny', 'scary', 'top5', 'chat', 'roast', 'quotes', 'highlights', 'reaction'])).max(8).default([]),
  twitchLayout: z.enum(['auto', 'split', 'full']).default('auto'),
  creditTitle: z.string().trim().max(300).default(''),
  creditChannel: z.string().trim().max(200).default(''),
  creditUrl: z.union([z.literal(''), z.string().trim().url().regex(/^https?:\/\//, 'link deve começar com http(s)://')]).default(''),
  range: z
    .object({ start: z.number().min(0), end: z.number().min(0) })
    .refine((r) => r.end - r.start >= 5, 'o trecho precisa ter pelo menos 5s')
    .nullable()
    .default(null),
  manualLayout: z
    .object({
      cam: z.object({ box: FrameBox, shape: z.enum(['rect', 'circle']), mode: z.enum(['fill', 'bubble']), track: z.boolean() }).nullable().optional(),
      content: z.object({ box: FrameBox, track: z.boolean() }).nullable().optional(),
    })
    .nullable()
    .default(null),
});

export const CreateJobSchema = z.object({
  inputFile: z.string().min(1).max(260),
  settings: JobSettingsSchema,
});

export const AppSettingsSchema = z
  .object({
    aiProvider: z.enum(['heuristic', 'gemini', 'anthropic', 'ollama']),
    geminiPlan: z.enum(['free', 'paid', 'hybrid']),
    geminiFlashModel: z.string().regex(/^[\w.\-]{1,80}$/),
    geminiProModel: z.string().regex(/^[\w.\-]{1,80}$/),
    geminiFallbackModel: z.union([z.literal(''), z.string().regex(/^[\w.\-]{1,80}$/)]),
    editingPrompt: z.string().max(6000),
    ptTranscript: z.boolean(),
    subtitleRemoval: z.enum(['crop', 'inpaint']),
    useReferences: z.boolean(),
    postLanguage: z.union([z.literal(''), z.string().regex(/^[a-z]{2,3}$/)]),
    anthropicModel: z.string().regex(/^[\w.\-]{1,80}$/),
    anthropicSelectModel: z.string().regex(/^[\w.\-]{1,80}$/),
    ollamaUrl: z.string().url().regex(/^https?:\/\//),
    ollamaModel: z.string().regex(/^[\w.\-:/]{1,80}$/),
    whisperModel: z.string().regex(/^[\w.\-/]{1,100}$/),
    whisperDevice: z.enum(['auto', 'cuda', 'cpu']),
    threads: z.coerce.number().int().min(1).max(64),
    hwAccel: z.enum(['none', 'nvenc']),
    sendFramesToAI: z.boolean(),
    useIllustrations: z.boolean(),
  })
  .partial();

export const SecretsSchema = z
  .object({
    GEMINI_API_KEY: z.string().max(300),
    ANTHROPIC_API_KEY: z.string().max(300),
    PIXABAY_API_KEY: z.string().max(300),
    TMDB_API_KEY: z.string().max(400),
  })
  .partial();

export function badRequest(error: unknown) {
  const msg =
    error instanceof z.ZodError
      ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      : error instanceof Error
        ? error.message
        : String(error);
  return Response.json({ error: msg }, { status: 400 });
}
