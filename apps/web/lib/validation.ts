import { z } from 'zod';

const Lang = z.string().regex(/^(auto|[a-z]{2,3})$/);

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
});

export const CreateJobSchema = z.object({
  inputFile: z.string().min(1).max(260),
  settings: JobSettingsSchema,
});

export const AppSettingsSchema = z
  .object({
    aiProvider: z.enum(['heuristic', 'gemini', 'anthropic', 'ollama']),
    geminiModel: z.string().regex(/^[\w.\-]{1,80}$/),
    anthropicModel: z.string().regex(/^[\w.\-]{1,80}$/),
    ollamaUrl: z.string().url().regex(/^https?:\/\//),
    ollamaModel: z.string().regex(/^[\w.\-:/]{1,80}$/),
    whisperModel: z.string().regex(/^[\w.\-/]{1,100}$/),
    whisperDevice: z.enum(['auto', 'cuda', 'cpu']),
    threads: z.coerce.number().int().min(1).max(64),
    hwAccel: z.enum(['none', 'nvenc']),
    sendFramesToAI: z.boolean(),
  })
  .partial();

export const SecretsSchema = z
  .object({
    GEMINI_API_KEY: z.string().max(300),
    ANTHROPIC_API_KEY: z.string().max(300),
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
