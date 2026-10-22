#!/usr/bin/env node
// Verifica o ambiente local: Node.js, FFmpeg/FFprobe, Python + faster-whisper, OpenCV, GPU/CUDA.
// Uso: node scripts/check-env.js [--json]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFfmpegBinary, resolvePython, resolveSystemPython } from './lib/binaries.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

function run(cmd, args, timeout = 30000) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true });
    return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || ''), status: r.status };
  } catch (e) {
    return { ok: false, out: String(e), status: -1 };
  }
}

const checks = [];
const add = (name, ok, detail, hint, required = true) => checks.push({ name, ok, detail, hint, required });

// Node
const nodeMajor = Number(process.versions.node.split('.')[0]);
add('Node.js', nodeMajor >= 20, `v${process.versions.node}`, 'Instale Node.js 20+');

// Dependências npm
const hasDeps = fs.existsSync(path.join(root, 'node_modules', 'next')) && fs.existsSync(path.join(root, 'node_modules', 'better-sqlite3'));
add('Dependências npm', hasDeps, hasDeps ? 'instaladas' : 'ausentes', 'Rode: npm install');

// FFmpeg / FFprobe
for (const bin of ['ffmpeg', 'ffprobe']) {
  const p = resolveFfmpegBinary(bin);
  const v = p ? run(p, ['-version']) : null;
  add(bin.toUpperCase(), !!(v && v.ok), v?.ok ? `${v.out.split('\n')[0].trim()} (${p})` : 'não encontrado', 'winget install Gyan.FFmpeg  (ou defina FFMPEG_PATH/FFPROBE_PATH no .env.local)');
}
const ffmpegPath = resolveFfmpegBinary('ffmpeg');
if (ffmpegPath) {
  const filters = run(ffmpegPath, ['-hide_banner', '-filters']).out;
  add('FFmpeg: libass (legendas)', /\bsubtitles\b/.test(filters), /\bsubtitles\b/.test(filters) ? 'filtro subtitles disponível' : 'sem libass', 'Use um build "full" do FFmpeg');
  const encoders = run(ffmpegPath, ['-hide_banner', '-encoders']).out;
  add('FFmpeg: NVENC (opcional)', /h264_nvenc/.test(encoders), /h264_nvenc/.test(encoders) ? 'h264_nvenc disponível' : 'indisponível', 'Opcional: aceleração de encode NVIDIA', false);
}

// Python
const sysPy = resolveSystemPython();
add('Python (sistema)', !!sysPy, sysPy || 'não encontrado', 'winget install Python.Python.3.12', false);
const py = resolvePython(root);
if (!py) {
  add('Python venv (.venv)', false, 'não encontrado', 'Rode: npm run setup:python');
} else {
  const v = run(py, ['--version']);
  add('Python venv (.venv)', v.ok, `${v.out.trim()} (${py})`, 'Rode: npm run setup:python');
  const fw = run(py, ['-c', 'import faster_whisper, ctranslate2; print(faster_whisper.__version__, ctranslate2.__version__, ctranslate2.get_cuda_device_count())']);
  const [fwv, ctv, cudaCount] = fw.ok ? fw.out.trim().split(/\s+/) : [];
  add('faster-whisper', fw.ok, fw.ok ? `faster-whisper ${fwv} / ctranslate2 ${ctv}` : fw.out.trim().split('\n').pop(), 'Rode: npm run setup:python');
  if (fw.ok) {
    add('CTranslate2 CUDA', Number(cudaCount) > 0, `${cudaCount} dispositivo(s) CUDA`, 'Sem GPU CUDA: a transcrição usará CPU (mais lento)', false);
    const libs = run(py, ['-c', 'import importlib.util as u; print(bool(u.find_spec("nvidia.cublas")), bool(u.find_spec("nvidia.cudnn")))']);
    const [cublas, cudnn] = libs.out.trim().split(/\s+/);
    add('cuBLAS/cuDNN (GPU Whisper)', cublas === 'True' && cudnn === 'True', `cublas=${cublas} cudnn=${cudnn}`, 'Opcional: npm run setup:cuda', false);
  }
  const cv = run(py, ['-c', 'import cv2; print(cv2.__version__)']);
  add('OpenCV (detecção de legendas antigas)', cv.ok, cv.ok ? cv.out.trim() : 'não instalado', 'Opcional: npm run setup:python', false);
}

// GPU
const smi = run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader']);
add('GPU NVIDIA', smi.ok, smi.ok ? smi.out.trim() : 'nvidia-smi não encontrado', 'Opcional: drivers NVIDIA', false);

// Pastas de dados
const dataDir = path.join(root, 'data');
add('Pasta data/', fs.existsSync(dataDir), dataDir, 'Será criada automaticamente na primeira execução', false);

if (asJson) {
  console.log(JSON.stringify({ ok: checks.every((c) => c.ok || !c.required), checks }, null, 2));
} else {
  console.log('\n  Local AI Video Clipper — verificação do ambiente\n');
  for (const c of checks) {
    const icon = c.ok ? '\x1b[32m✔\x1b[0m' : c.required ? '\x1b[31m✘\x1b[0m' : '\x1b[33m!\x1b[0m';
    console.log(`  ${icon} ${c.name.padEnd(38)} ${c.detail}`);
    if (!c.ok && c.hint) console.log(`      → ${c.hint}`);
  }
  const failed = checks.filter((c) => !c.ok && c.required);
  console.log(failed.length ? `\n  ${failed.length} item(ns) obrigatório(s) faltando.\n` : '\n  Ambiente pronto.\n');
  process.exitCode = failed.length ? 1 : 0;
}
