// Canal de curiosidades — etapa 1: transcreve o vídeo-fonte e gera a galeria de ideias (sem renderizar nada).
// O editor revisa/ajusta as ideias no painel (/curiosidades) e só as aprovadas viram um job de render.
import fs from 'node:fs';
import path from 'node:path';
import { aiCuriosityIdeas, createLLM, estimateCostUsd, transcribe } from '@clipper/ai-providers';
import { buildSentences } from '@clipper/clip-selection';
import { CURIOSITY_TEMPLATES, type AppSettings, type CuriosityAnalysis, type CuriosityIdea, type CuriosityTemplateKey, type Job, type Transcript } from '@clipper/shared';
import { addJobLog, dataPaths, getAppSettings, setJobResult, updateJobProgress } from '@clipper/shared/server';
import { extractAudio, probe, validateProbe } from '@clipper/video-processing';
import { combineGuidelines } from './references';
import { writeCuriosityAnalysis } from './curiosity-store';
import { transcriptCachePath } from './pipeline';

/** Sem IA: janelas de ~30s em frases inteiras, as mais faladas primeiro; o roteiro é o próprio texto do trecho. */
function heuristicIdeas(transcript: Transcript, templates: CuriosityTemplateKey[], count: number): CuriosityIdea[] {
  const sentences = buildSentences(transcript);
  const windows: { start: number; end: number; text: string; words: number }[] = [];
  let i = 0;
  while (i < sentences.length) {
    let j = i;
    while (j + 1 < sentences.length && sentences[j + 1].end - sentences[i].start <= 32) j++;
    const part = sentences.slice(i, j + 1);
    windows.push({ start: sentences[i].start, end: sentences[j].end, text: part.map((x) => x.text).join(' '), words: part.reduce((a, x) => a + x.words.length, 0) });
    i = j + 1;
  }
  return windows
    .filter((w) => w.end - w.start >= 12)
    .sort((a, b) => b.words / (b.end - b.start) - a.words / (a.end - a.start))
    .slice(0, count)
    .sort((a, b) => a.start - b.start)
    .map((w, k) => {
      const tpl = CURIOSITY_TEMPLATES.find((t) => t.key === templates[k % templates.length])!;
      const first = w.text.split(/(?<=[.!?…])\s+/)[0].slice(0, 110);
      return {
        id: `h${k + 1}`,
        template: tpl.key,
        title: first,
        hook: tpl.key === 'voce_sabia' ? `Você sabia disso?` : first,
        script: `${w.text.slice(0, 600)} ${tpl.cta.replace(/"/g, '')}`,
        cta: tpl.cta.replace(/"/g, ''),
        segments: [{ start: Math.max(0, w.start - 0.1), end: w.end + 0.3, label: null }],
        score: 50,
        reason: 'Trecho com fala densa (seleção local, sem IA)',
        hashtags: ['#curiosidades', '#vocesabia'],
      };
    });
}

export async function runCuriosityAnalysis(job: Job, signal: AbortSignal): Promise<number> {
  const forced = process.env.CLIPPER_FORCE_PROVIDER as AppSettings['aiProvider'] | undefined;
  const app = { ...getAppSettings(), ...(forced ? { aiProvider: forced } : {}) };
  const s = job.settings;
  const opts = s.curiosity?.analyze ?? { templates: CURIOSITY_TEMPLATES.map((t) => t.key), count: 8 };
  const templates = opts.templates.length ? opts.templates : CURIOSITY_TEMPLATES.map((t) => t.key);
  const log = (level: 'info' | 'warn' | 'error', msg: string) => {
    addJobLog(job.id, level, msg);
    console.log(`[job ${job.id.slice(0, 8)}] ${level.toUpperCase()} ${msg}`);
  };
  const tempDir = path.join(dataPaths.temp, job.id);
  fs.mkdirSync(tempDir, { recursive: true });

  updateJobProgress(job.id, 'ingest', 0.02);
  if (!fs.existsSync(job.inputPath)) throw new Error(`Arquivo de entrada não existe: ${job.inputPath}`);
  const info = await probe(job.inputPath, signal);
  const problems = validateProbe(info);
  if (problems.length) throw new Error(problems.join(' '));

  // Transcrição com o mesmo cache global do pipeline: o render depois não transcreve de novo
  const cache = transcriptCachePath(job.inputPath, app.whisperModel, s.sourceLanguage);
  let transcript: Transcript;
  if (fs.existsSync(cache)) {
    transcript = JSON.parse(fs.readFileSync(cache, 'utf8')) as Transcript;
    log('info', 'Transcrição reaproveitada do cache');
  } else {
    log('info', `Transcrevendo com faster-whisper (modelo ${app.whisperModel})`);
    updateJobProgress(job.id, 'transcribe', 0.05);
    const wav = path.join(tempDir, 'audio.wav');
    await extractAudio(job.inputPath, wav, { signal, duration: info.duration });
    transcript = await transcribe({
      audioPath: wav,
      outputJson: path.join(tempDir, 'whisper-raw.json'),
      model: app.whisperModel,
      device: app.whisperDevice,
      language: s.sourceLanguage,
      threads: app.threads,
      signal,
      onProgress: (p) => updateJobProgress(job.id, 'transcribe', 0.05 + p * 0.6),
      onLog: (m) => log('info', `whisper: ${m}`),
    });
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(transcript));
  }
  if (!transcript.segments.length) throw new Error('Nenhuma fala detectada no vídeo-fonte.');

  updateJobProgress(job.id, 'select', 0.7);
  const llm = (() => {
    try {
      return createLLM(app, 'select');
    } catch (e) {
      log('warn', `${(e as Error).message} — ideias geradas pela heurística local`);
      return null;
    }
  })();
  let ideas: CuriosityIdea[] = [];
  let summary = '';
  if (llm) {
    log('info', `Gerando ${opts.count} ideias com ${llm.name}/${llm.model} (formatos: ${templates.join(', ')})`);
    try {
      const out = await aiCuriosityIdeas({ llm, transcript, templates, count: opts.count, topic: opts.topic, targetSeconds: opts.targetSeconds, guidelines: combineGuidelines(app.editingPrompt, null), signal, log: (l, m) => log(l, m) });
      ideas = out.ideas;
      summary = out.summary;
    } catch (e) {
      if (signal.aborted) throw e;
      log('warn', `IA falhou (${(e as Error).message}); usando a heurística local`);
    }
  }
  if (!ideas.length) ideas = heuristicIdeas(transcript, templates, opts.count);
  if (!ideas.length) throw new Error('Nenhuma ideia gerada.');

  writeCuriosityAnalysis({
    jobId: job.id,
    videoName: job.videoName,
    inputPath: job.inputPath,
    duration: info.duration,
    language: transcript.language,
    provider: llm ? `${llm.name}/${llm.model}` : 'heuristic',
    summary,
    ideas: ideas.sort((a, b) => b.score - a.score),
    createdAt: new Date().toISOString(),
  });
  setJobResult(job.id, { provider: llm ? `${llm.name}/${llm.model}` : 'heuristic', language: transcript.language, aiUsage: llm ? { ...llm.usage, costUsd: llm.free ? 0 : estimateCostUsd(llm.model, llm.usage), free: llm.free } : undefined });
  updateJobProgress(job.id, 'export', 1);
  log('info', `${ideas.length} ideia(s) prontas para revisar em /curiosidades`);
  return ideas.length;
}
