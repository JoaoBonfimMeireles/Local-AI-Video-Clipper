// "Melhorar qualidade": upscale por IA 100% local (Real-ESRGAN ncnn-vulkan na GPU, sem tokens).
// Extrai os quadros com o FFmpeg, aumenta cada um com o Real-ESRGAN e remonta com o áudio original.
import fs from 'node:fs';
import path from 'node:path';
import type { UpscaleModel } from '@clipper/shared';
import { getRepoRoot, pythonScriptPath, resolvePythonBinary, resolveRealesrgan, runProcess } from '@clipper/shared/server';
import { runFfmpeg } from './ffmpeg';
import { probe } from './probe';

export interface UpscaleOptions {
  input: string;
  output: string;
  /** Altura-alvo do lado menor (480, 720, 1080). */
  target: number;
  model: UpscaleModel;
  workDir: string;
  signal?: AbortSignal;
  /** Fase (extract/upscale/encode), fração 0..1 e quadros prontos/total durante o upscale. */
  onProgress?: (phase: 'extract' | 'upscale' | 'encode', p: number, frames?: { done: number; total: number }) => void;
  log?: (msg: string) => void;
}

/** Fator do Real-ESRGAN para chegar ao alvo. O modo rápido é só uma "pincelada": no máximo 3x, e o lanczos completa o resto. */
export function upscaleFactor(shortSide: number, target: number, model: UpscaleModel): number {
  if (model !== 'fast') return 4; // realesrgan-x4plus e realesr-general-x4v3 só existem em 4x
  return target / shortSide <= 2 ? 2 : 3;
}

/** Apaga uma pasta tolerando EPERM/EBUSY (exFAT/Windows segurando arquivo): tenta de novo e desiste em silêncio. */
export function removeDirTolerant(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* arquivo ainda preso pelo Windows: cleanOrphanTemp apaga na próxima inicialização */
  }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Modelos que rodam no Python do app (torch/onnxruntime na GPU) em vez do realesrgan-ncnn-vulkan. */
const viaPython = (m: UpscaleModel) => m === 'realistic' || m === 'faces';
/** Nome do modelo no realesrgan-ncnn-vulkan (detailedFaces aumenta com o x4plus e depois restaura os rostos no Python). */
const ncnnName = (m: UpscaleModel) => (m === 'detailed' || m === 'detailedFaces' ? 'realesrgan-x4plus' : 'realesr-animevideov3');

/** enhance_frames.py: aumenta 4x (realesr-general-x4v3) e, com --faces, restaura os rostos (GFPGAN). */
async function runEnhancePython(args: string[], signal?: AbortSignal): Promise<void> {
  const models = path.join(getRepoRoot(), 'tools', 'enhance');
  if (!fs.existsSync(path.join(models, 'realesr-general-x4v3.pth')) || !fs.existsSync(path.join(models, 'gfpgan_1.4.onnx'))) {
    throw new Error('Modelos de "Melhorar qualidade" ausentes em tools/enhance. Rode: npm run setup:python -- --cuda');
  }
  const res = await runProcess(resolvePythonBinary(), ['-I', pythonScriptPath('enhance_frames.py'), ...args, '--models', models], { signal, captureStdout: false, stderrTailBytes: 6000 });
  if (res.code !== 0) {
    const tail = res.stderrTail.split(/\r?\n/).filter((l) => l && !/^done \d+\/\d+$/.test(l.trim()) && !/WARN/.test(l)).slice(-5).join('\n');
    const vram = /out of memory|CUDA error|cudaMalloc/i.test(res.stderrTail) ? '\nA GPU ficou sem memória: feche jogos/OBS ou escolha um alvo menor.' : '';
    throw new Error(`Melhorar qualidade (Python) falhou (código ${res.code}):\n${tail}${vram}`);
  }
}

/** Prévia de um quadro: original | cada modelo, todos já no tamanho final (width x height) para comparar de verdade. */
export async function enhanceCompare(opts: {
  frame: string;
  outDir: string;
  width: number;
  height: number;
  models: UpscaleModel[];
  signal?: AbortSignal;
}): Promise<{ original: string } & Partial<Record<UpscaleModel, string>>> {
  const { signal } = opts;
  const stamp = Date.now();
  const sized = (name: string) => path.join(opts.outDir, `${name}_${stamp}.png`);
  const resize = (src: string, dest: string, flags: string) => runFfmpeg(['-i', src, '-vf', `scale=${opts.width}:${opts.height}:flags=${flags}`, dest], { signal });
  const out: { original: string } & Partial<Record<UpscaleModel, string>> = { original: sized('original') };
  await resize(opts.frame, out.original, 'bicubic');
  const raw = (name: string) => path.join(opts.outDir, `raw_${name}_${stamp}.png`);
  // 1) Os do realesrgan-ncnn primeiro (detailedFaces usa o mesmo aumento do detailed)
  const ncnn = [...new Set(opts.models.filter((x) => !viaPython(x)).map((m) => (m === 'detailedFaces' ? 'detailed' : m)))];
  for (const m of ncnn) {
    const { exe, models } = resolveRealesrgan();
    const r = await runProcess(exe, ['-i', opts.frame, '-o', raw(m), '-n', ncnnName(m), '-s', String(upscaleFactor(Math.min(opts.width, opts.height) / 4, Math.min(opts.width, opts.height), m)), '-m', models, '-f', 'png'], {
      cwd: path.dirname(exe),
      signal,
      captureStdout: false,
      stderrTailBytes: 4000,
    });
    if (r.code !== 0) throw new Error(`Real-ESRGAN falhou (código ${r.code}).`);
  }
  // 2) Uma passada só do Python: realista, realista + rostos e os rostos do detalhado
  const py = opts.models.filter(viaPython);
  const detailedFaces = opts.models.includes('detailedFaces');
  if (py.length || detailedFaces) {
    await runEnhancePython(
      [
        '--in', opts.frame, '--out', raw('realistic'), '--faces-out', raw('faces'),
        ...(detailedFaces ? ['--faces-also', raw('detailed'), raw('detailedFaces')] : []),
      ],
      signal,
    );
  }
  for (const m of opts.models) await resize(raw(m), (out[m] = sized(m)), 'lanczos');
  for (const f of fs.readdirSync(opts.outDir)) if (f.startsWith('raw_')) fs.rmSync(path.join(opts.outDir, f), { force: true });
  return out;
}

/** Retorna false (sem gerar saída) quando o vídeo já tem a resolução-alvo. */
export async function upscaleVideo(opts: UpscaleOptions): Promise<{ width: number; height: number } | false> {
  const { signal } = opts;
  const report = opts.onProgress ?? (() => undefined);
  const log = opts.log ?? (() => undefined);
  const info = await probe(opts.input, signal);
  const short = Math.min(info.width, info.height);
  if (short >= opts.target) {
    log(`Melhorar qualidade: o vídeo já tem ${info.width}x${info.height} (≥ ${opts.target}p), nada a fazer.`);
    return false;
  }
  const python = viaPython(opts.model);
  const scale = upscaleFactor(short, opts.target, opts.model);
  const restoreFaces = opts.model === 'detailedFaces';
  const modelName = opts.model === 'faces' ? 'realesr-general-x4v3 + GFPGAN' : opts.model === 'realistic' ? 'realesr-general-x4v3' : ncnnName(opts.model);
  // Tamanho final: lado menor = alvo, mantendo a proporção (acima do fator da IA, o lanczos completa)
  const ratio = opts.target / short;
  const width = even(info.width * ratio);
  const height = even(info.height * ratio);
  const fps = Math.min(60, info.fps || 30);

  const inDir = path.join(opts.workDir, 'up_in');
  const upDir = path.join(opts.workDir, 'up_out');
  // detailedFaces: os rostos são restaurados numa 2ª passada, de up_out para up_faces
  const outDir = restoreFaces ? path.join(opts.workDir, 'up_faces') : upDir;
  removeDirTolerant(inDir);
  removeDirTolerant(upDir);
  removeDirTolerant(outDir);
  fs.mkdirSync(inDir, { recursive: true });
  fs.mkdirSync(upDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  try {
    // 1) Quadros em PNG, taxa constante (a remontagem usa a mesma taxa)
    report('extract', 0);
    await runFfmpeg(['-i', opts.input, '-an', '-sn', '-fps_mode', 'cfr', '-r', fps.toFixed(3), '-pix_fmt', 'rgb24', path.join(inDir, '%08d.png')], {
      signal,
      expectedDuration: info.duration,
      onProgress: (p) => report('extract', p),
    });
    const total = fs.readdirSync(inDir).filter((f) => f.endsWith('.png')).length;
    if (!total) throw new Error('Nenhum quadro extraído do vídeo.');
    log(`Melhorar qualidade: ${total} quadros de ${info.width}x${info.height} → ${width}x${height} (Real-ESRGAN ${modelName} ${scale}x na GPU${restoreFaces ? ' + rostos (GFPGAN)' : ''}${ratio > scale ? ' + ajuste final' : ''})`);

    // 2) Real-ESRGAN na pasta inteira; o progresso vem da contagem de quadros prontos
    report('upscale', 0, { done: 0, total });
    let last = -1;
    const timer = setInterval(() => {
      let done = 0;
      try {
        // detailedFaces: metade do progresso é o aumento, a outra metade os rostos
        done = restoreFaces ? (fs.readdirSync(upDir).length + fs.readdirSync(outDir).length) / 2 : fs.readdirSync(outDir).length;
      } catch {
        return;
      }
      done = Math.floor(done);
      if (done !== last) {
        last = done;
        report('upscale', Math.min(1, done / total), { done: Math.min(done, total), total });
      }
    }, 1000);
    let res: { code: number | null; stderrTail: string } = { code: 0, stderrTail: '' };
    try {
      if (python) await runEnhancePython(['--in', inDir, '--out', outDir, ...(opts.model === 'faces' ? ['--faces'] : [])], signal);
      else {
        const { exe, models } = resolveRealesrgan();
        res = await runProcess(exe, ['-i', inDir, '-o', upDir, '-n', ncnnName(opts.model), '-s', String(scale), '-m', models, '-f', 'png', '-j', '1:2:2'], {
          cwd: path.dirname(exe),
          signal,
          captureStdout: false,
          stderrTailBytes: 4000,
        });
        if (restoreFaces && res.code === 0) {
          removeDirTolerant(inDir);
          await runEnhancePython(['--in', upDir, '--out', outDir, '--no-upscale', '--faces'], signal);
        }
      }
    } finally {
      clearInterval(timer);
    }
    const done = fs.readdirSync(outDir).filter((f) => f.endsWith('.png')).length;
    if (res.code !== 0 || done < total) {
      const tail = res.stderrTail.split(/\r?\n/).filter((l) => l && !/^\d+[.,]\d+%$/.test(l.trim())).slice(-5).join('\n');
      const vram = /vkAllocateMemory|out of memory|VK_ERROR/i.test(res.stderrTail) ? '\nA GPU ficou sem memória: feche jogos/OBS ou escolha um alvo menor.' : '';
      throw new Error(`Real-ESRGAN falhou (código ${res.code}, ${done}/${total} quadros):\n${tail}${vram}`);
    }
    report('upscale', 1, { done: total, total });
    removeDirTolerant(inDir);

    // 3) Remonta na resolução final com o áudio do original (sem recodificar o áudio)
    report('encode', 0);
    await runFfmpeg(
      [
        '-framerate', fps.toFixed(3), '-i', path.join(outDir, '%08d.png'), '-i', opts.input,
        '-map', '0:v:0', ...(info.hasAudio ? ['-map', '1:a:0', '-c:a', 'copy'] : []),
        '-vf', `scale=${width}:${height}:flags=lanczos,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
        '-movflags', '+faststart', '-shortest', opts.output,
      ],
      { signal, expectedDuration: info.duration, onProgress: (p) => report('encode', p) },
    );
    report('encode', 1);
    return { width, height };
  } finally {
    removeDirTolerant(inDir);
    removeDirTolerant(upDir);
    removeDirTolerant(outDir);
  }
}
