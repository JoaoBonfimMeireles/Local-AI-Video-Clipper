import fs from 'node:fs';
import { pythonScriptPath, resolvePythonBinary, runProcess } from '@clipper/shared/server';
import type { Transcript, WhisperDevice } from '@clipper/shared';

export interface TranscribeOptions {
  audioPath: string;
  outputJson: string;
  model: string;
  device: WhisperDevice;
  language?: string;
  threads?: number;
  signal?: AbortSignal;
  onProgress?: (p: number) => void;
  onLog?: (msg: string) => void;
}

const MODEL_RE = /^[\w.\-/]{1,100}$/;
const LANG_RE = /^(auto|[a-z]{2,3})$/;

/** Ponte Node -> Python (faster-whisper). Comunicação por linhas no stderr + JSON no disco. */
export async function transcribe(opts: TranscribeOptions): Promise<Transcript> {
  if (!MODEL_RE.test(opts.model)) throw new Error(`Modelo Whisper inválido: ${opts.model}`);
  const language = opts.language || 'auto';
  if (!LANG_RE.test(language)) throw new Error(`Idioma inválido: ${language}`);

  const args = [
    pythonScriptPath('transcribe.py'),
    '--audio', opts.audioPath,
    '--out', opts.outputJson,
    '--model', opts.model,
    '--device', opts.device,
    '--language', language,
    '--threads', String(Math.max(1, Math.min(64, Math.floor(opts.threads ?? 4)))),
  ];
  const res = await runProcess(resolvePythonBinary(), args, {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
    signal: opts.signal,
    captureStdout: false,
    onStderrLine: (line) => {
      if (line.startsWith('PROGRESS ')) {
        const p = Number(line.slice(9));
        if (Number.isFinite(p)) opts.onProgress?.(p);
      } else if (line.startsWith('LOG ')) {
        opts.onLog?.(line.slice(4));
      }
    },
  });
  if (res.code !== 0 || !fs.existsSync(opts.outputJson)) {
    throw new Error(`faster-whisper falhou (código ${res.code}): ${res.stderrTail.split('\n').slice(-6).join('\n')}`);
  }
  return JSON.parse(fs.readFileSync(opts.outputJson, 'utf8')) as Transcript;
}

export interface SubtitleRegion {
  found: boolean;
  y?: number;
  h?: number;
  confidence?: number;
}

/** Detecta a faixa de legendas queimadas via OpenCV (frações da altura). */
export async function detectSubtitleRegion(framePaths: string[], signal?: AbortSignal): Promise<SubtitleRegion> {
  if (!framePaths.length) return { found: false };
  const res = await runProcess(resolvePythonBinary(), [pythonScriptPath('detect_subtitles.py'), ...framePaths.slice(0, 40)], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    signal,
    timeoutMs: 120_000,
  });
  try {
    const parsed = JSON.parse(res.stdout.trim().split('\n').pop() || '{}');
    if (parsed.found && typeof parsed.y === 'number' && typeof parsed.h === 'number') {
      return { found: true, y: clamp01(parsed.y), h: clamp01(parsed.h), confidence: parsed.confidence };
    }
  } catch {
    /* saída inesperada */
  }
  return { found: false };
}

export interface DetectedFace {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

/** Rostos por imagem (YuNet local). Em caso de erro, devolve listas vazias — o enquadramento segue só com a IA. */
export async function detectFaces(framePaths: string[], signal?: AbortSignal): Promise<DetectedFace[][]> {
  const out: DetectedFace[][] = [];
  for (let i = 0; i < framePaths.length; i += 80) {
    const batch = framePaths.slice(i, i + 80);
    try {
      const res = await runProcess(resolvePythonBinary(), [pythonScriptPath('detect_faces.py'), ...batch], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, signal, timeoutMs: 180_000 });
      const parsed = JSON.parse(res.stdout.trim().split('\n').pop() || '[]');
      if (!Array.isArray(parsed)) throw new Error(parsed.error ?? 'saída inválida');
      out.push(...parsed.map((r: { faces?: DetectedFace[] }) => r.faces ?? []));
    } catch (e) {
      if (signal?.aborted) throw e;
      out.push(...batch.map(() => []));
    }
  }
  return out;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
