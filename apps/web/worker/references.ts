// Clipes de referência: cortes virais de outros canais que ensinam o ESTILO (não o conteúdo).
// Cada clipe é analisado UMA vez (Whisper local + métricas de ritmo + 1 chamada pequena de IA) e o
// conjunto vira um guia de estilo compacto, guardado em cache e injetado nos prompts de seleção/edição.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { askJson, imageFromFile, transcribe, wordsToTimedText, type LLMProvider } from '@clipper/ai-providers';
import { flattenWords, type AppSettings } from '@clipper/shared';
import { buildReferencePrompt, buildStyleGuidePrompt, REFERENCE_SYSTEM, ReferenceStyleSchema, StyleGuideSchema, type ReferenceStyle } from '@clipper/editing-planner';
import { dataPaths } from '@clipper/shared/server';
import { analyzeEnergy, detectSceneChanges, extractAudio, extractFrames, findEnergyPeaks, pickFrameTimes, probe } from '@clipper/video-processing';

const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi'];
type Log = (level: 'info' | 'warn', msg: string) => void;

export interface ReferenceInfo {
  file: string;
  name: string;
  key: string;
  analyzed: boolean;
  style?: ReferenceStyle;
  stats?: Record<string, number>;
}

const cacheDir = () => path.join(dataPaths.root, 'cache', 'references');

/** Vídeos em data/references, inclusive em subpastas (cada subpasta = um nicho com guia próprio). */
function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else if (VIDEO_EXT.includes(path.extname(e.name).toLowerCase())) out.push(r);
  }
  return out;
}

export function listReferences(): ReferenceInfo[] {
  if (!fs.existsSync(dataPaths.references)) return [];
  return walk(dataPaths.references)
    .sort()
    .map((name) => {
      const file = path.join(dataPaths.references, name);
      const st = fs.statSync(file);
      const key = createHash('sha1').update(`${name}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('hex').slice(0, 16);
      const cached = path.join(cacheDir(), `${key}.json`);
      if (fs.existsSync(cached)) {
        const data = JSON.parse(fs.readFileSync(cached, 'utf8'));
        return { file, name, key, analyzed: true, style: data.style, stats: data.stats };
      }
      return { file, name, key, analyzed: false };
    });
}

/** Nicho = subpasta (vazio para vídeos soltos na raiz). */
const nicheOf = (r: ReferenceInfo) => (r.name.includes('/') ? r.name.slice(0, r.name.lastIndexOf('/')) : '');
const baseName = (r: ReferenceInfo) => path.parse(r.name).name.replace(/^vidssave\.com\s*/i, '');

async function analyzeReference(ref: ReferenceInfo, app: AppSettings, llm: LLMProvider, log: Log, signal?: AbortSignal): Promise<void> {
  // Pasta nova a cada tentativa: a de um job cancelado pode ficar travada (EPERM) no exFAT
  const work = path.join(dataPaths.temp, `ref-${ref.key}-${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    const info = await probe(ref.file, signal);
    let transcriptText = '';
    let words = 0;
    let energy: number[] = [];
    if (info.hasAudio) {
      const wav = path.join(work, 'audio.wav');
      await extractAudio(ref.file, wav, { signal, duration: info.duration });
      const t = await transcribe({ audioPath: wav, outputJson: path.join(work, 't.json'), model: app.whisperModel, device: app.whisperDevice, threads: app.threads, signal });
      const flat = flattenWords(t.segments);
      words = flat.length;
      transcriptText = wordsToTimedText(flat);
      energy = await analyzeEnergy(wav, signal);
    }
    const scenes = await detectSceneChanges(ref.file, { signal, duration: info.duration });
    const peaks = findEnergyPeaks(energy);
    const stats = {
      duracao_s: Number(info.duration.toFixed(1)),
      cortes_por_min: Number(((scenes.length / Math.max(1, info.duration)) * 60).toFixed(1)),
      palavras_por_s: Number((words / Math.max(1, info.duration)).toFixed(2)),
      picos_de_volume: peaks.length,
      vertical: info.height > info.width ? 1 : 0,
    };
    const statsText = `duração ${stats.duracao_s}s; ${stats.cortes_por_min} cortes de câmera/min; ${stats.palavras_por_s} palavras/s; ${stats.picos_de_volume} picos de volume; ${stats.vertical ? 'vertical 9:16' : 'horizontal'}`;
    const useImages = app.sendFramesToAI && llm.supportsImages;
    const frames = useImages ? await extractFrames(ref.file, pickFrameTimes(info.duration, { scenes }, 6), path.join(work, 'frames'), { width: 384, signal }) : [];
    const style = await askJson(
      llm,
      {
        system: REFERENCE_SYSTEM,
        prompt: buildReferencePrompt({
          name: baseName(ref),
          transcript: transcriptText.slice(0, 6000),
          stats: statsText,
          visualNotes: frames.length ? frames.map((f, i) => `imagem ${i + 1}: t=${f.time.toFixed(1)}s`).join('\n') : undefined,
        }),
        images: frames.length ? frames.map((f) => imageFromFile(f.path)) : undefined,
        signal,
      },
      ReferenceStyleSchema,
      log,
    );
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(path.join(cacheDir(), `${ref.key}.json`), JSON.stringify({ name: ref.name, stats, style }));
    log('info', `Referência analisada: ${ref.name} (${statsText})`);
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* limpeza na próxima inicialização */
    }
  }
}

/** Guia em cache para o conjunto atual de referências analisadas (null se não houver). */
export function cachedStyleGuide(): string | null {
  const refs = listReferences().filter((r) => r.analyzed);
  if (!refs.length) return null;
  const file = path.join(cacheDir(), `guide-${guideKey(refs)}.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).guide as string) : null;
}

const guideKey = (refs: ReferenceInfo[]) => createHash('sha1').update(refs.map((r) => r.key).sort().join('|')).digest('hex').slice(0, 16);

function styleToText(s: ReferenceStyle): string {
  return [
    `- Gancho: ${s.hook}`,
    `- Estrutura: ${s.structure}`,
    `- Ritmo: ${s.pacing}`,
    s.humor && `- Humor: ${s.humor}`,
    `- Edição: ${s.editing}`,
    s.captions && `- Legendas: ${s.captions}`,
    s.ending && `- Final: ${s.ending}`,
    ...s.tips.map((t) => `- ${t}`),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Analisa as referências novas (se `analyzeMissing`) e devolve o guia de estilo do conjunto.
 * 1 referência → o guia é a própria análise (sem chamada extra); várias → 1 chamada que junta o que é comum.
 */
export async function getStyleGuide(args: { app: AppSettings; llm: LLMProvider | null; log: Log; signal?: AbortSignal; analyzeMissing: boolean }): Promise<string | null> {
  let refs = listReferences();
  if (!refs.length) return null;
  const missing = refs.filter((r) => !r.analyzed);
  if (missing.length && args.analyzeMissing && args.llm) {
    args.log('info', `Analisando ${missing.length} clipe(s) de referência novo(s) (uma vez só; fica em cache)`);
    for (const ref of missing) {
      try {
        await analyzeReference(ref, args.app, args.llm, args.log, args.signal);
      } catch (e) {
        if (args.signal?.aborted) throw e;
        args.log('warn', `Não foi possível analisar a referência ${ref.name}: ${(e as Error).message}`);
      }
    }
    refs = listReferences();
  }
  const analyzed = refs.filter((r) => r.analyzed && r.style);
  if (!analyzed.length) return null;
  const file = path.join(cacheDir(), `guide-${guideKey(analyzed)}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).guide as string;

  // Um guia por nicho (subpasta); a IA aplica o nicho que combina com o vídeo
  const groups = new Map<string, ReferenceInfo[]>();
  for (const r of analyzed) groups.set(nicheOf(r), [...(groups.get(nicheOf(r)) ?? []), r]);
  const parts: string[] = [];
  for (const [niche, list] of groups) {
    let g: string;
    if (list.length === 1 || !args.llm) {
      g = list.map((r) => styleToText(r.style!)).join('\n');
    } else {
      const res = await askJson(
        args.llm,
        { system: 'Você é um editor-chefe de clipes virais. Responda SOMENTE com JSON válido.', prompt: buildStyleGuidePrompt(list.map((r) => ({ name: baseName(r), style: r.style }))), signal: args.signal },
        StyleGuideSchema,
        args.log,
      );
      g = res.guide;
    }
    parts.push(groups.size > 1 && niche ? `[Nicho: ${niche}] (use quando o vídeo for desse tipo)\n${g}` : g);
  }
  const guide = parts.join('\n\n');
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ guide, refs: analyzed.map((r) => r.name), createdAt: new Date().toISOString() }));
  args.log('info', `Guia de estilo atualizado a partir de ${analyzed.length} referência(s)`);
  return guide;
}

/** Junta as diretrizes do usuário com o guia de estilo das referências. */
export function combineGuidelines(editingPrompt: string, guide: string | null): string {
  return [editingPrompt.trim(), guide ? `GUIA DE ESTILO (aprendido de clipes virais de referência — siga a fórmula, não copie o conteúdo):\n${guide}` : '']
    .filter(Boolean)
    .join('\n\n');
}

/** Job "Analisar referências agora": analisa os clipes novos e atualiza o guia, sem vídeo de entrada. */
export async function runReferenceJob(job: { id: string }, signal: AbortSignal): Promise<{ rendered: number; failed: number }> {
  const { addJobLog, getAppSettings, updateJobProgress } = await import('@clipper/shared/server');
  const { createLLM } = await import('@clipper/ai-providers');
  const log: Log = (level, msg) => {
    addJobLog(job.id, level, msg);
    console.log(`[referências] ${msg}`);
  };
  const app = getAppSettings();
  const llm = createLLM(app, 'edit');
  if (!llm) throw new Error('Analisar referências precisa de um provedor de IA (Configurações).');
  llm.onNotice = (m) => log('warn', m);
  const refs = listReferences();
  if (!refs.length) throw new Error(`Nenhum clipe em ${dataPaths.references}`);
  updateJobProgress(job.id, 'select', 0.1);
  const guide = await getStyleGuide({ app, llm, log, signal, analyzeMissing: true });
  updateJobProgress(job.id, 'export', 1);
  const done = listReferences().filter((r) => r.analyzed).length;
  log('info', `${done}/${refs.length} referência(s) analisada(s)${guide ? '; guia de estilo pronto' : ''} — ${llm.usage.inputTokens.toLocaleString('pt-BR')} tokens de entrada`);
  return { rendered: done ? 1 : 0, failed: refs.length - done };
}
