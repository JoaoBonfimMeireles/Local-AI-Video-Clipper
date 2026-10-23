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

export interface CamBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Retângulo exato da facecam (o "quadradinho" do streamer) a partir do rosto dele e dos frames do corte:
 * procura a moldura fixa em volta do rosto. null se não der para medir.
 */
export async function detectCamBox(framePaths: string[], face: { x: number; y: number; w: number; h: number }, signal?: AbortSignal): Promise<{ box: CamBox; method: string } | null> {
  const step = Math.max(1, Math.floor(framePaths.length / 30));
  const files = framePaths.filter((_, i) => i % step === 0).slice(0, 30);
  try {
    const res = await runProcess(
      resolvePythonBinary(),
      [pythonScriptPath('detect_cam.py'), ...[face.x, face.y, face.w, face.h].map((v) => v.toFixed(4)), ...files],
      { env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, signal, timeoutMs: 120_000 },
    );
    const parsed = JSON.parse(res.stdout.trim().split('\n').pop() || '{}');
    return parsed.box ? { box: parsed.box, method: parsed.method } : null;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

/**
 * Player do vídeo assistido num react (post do Instagram/Facebook, YouTube...) dentro da tela: a região que muda,
 * encaixada nas bordas fixas do player. `fill` = fração da área livre (sem a facecam) que ele ocupa.
 */
export async function detectPlayerBox(framePaths: string[], cam: CamBox | null, signal?: AbortSignal): Promise<{ box: CamBox; score: number; fill: number } | null> {
  const step = Math.max(1, Math.floor(framePaths.length / 40));
  const files = framePaths.filter((_, i) => i % step === 0).slice(0, 40);
  const ex = cam ? [cam.x0, cam.y0, cam.x1, cam.y1] : [-1, -1, -1, -1];
  try {
    const res = await runProcess(resolvePythonBinary(), [pythonScriptPath('detect_player.py'), ...ex.map((v) => v.toFixed(4)), ...files], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      signal,
      timeoutMs: 120_000,
    });
    const parsed = JSON.parse(res.stdout.trim().split('\n').pop() || '{}');
    return parsed.box ? { box: parsed.box, score: parsed.score ?? 0, fill: parsed.fill ?? 0 } : null;
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
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
