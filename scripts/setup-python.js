#!/usr/bin/env node
// Cria .venv na raiz e instala as dependências Python (faster-whisper, OpenCV).
// --cuda também instala cuBLAS/cuDNN (CUDA 12) para rodar o Whisper na GPU NVIDIA.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePython, resolveSystemPython } from './lib/binaries.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withCuda = process.argv.includes('--cuda');

function sh(cmd, args) {
  console.log(`> ${path.basename(cmd)} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) {
    console.error(`Falhou (código ${r.status}).`);
    process.exit(1);
  }
}

let py = resolvePython(root);
if (!py) {
  const sys = resolveSystemPython();
  if (!sys) {
    console.error('Python 3.10+ não encontrado. Instale com: winget install Python.Python.3.12');
    process.exit(1);
  }
  sh(sys, ['-m', 'venv', path.join(root, '.venv')]);
  py = resolvePython(root);
}

const req = path.join(root, 'packages', 'ai-providers', 'python', 'requirements.txt');
sh(py, ['-m', 'pip', 'install', '--upgrade', 'pip']);
sh(py, ['-m', 'pip', 'install', '-r', req]);
if (withCuda) {
  const reqCuda = path.join(root, 'packages', 'ai-providers', 'python', 'requirements-cuda.txt');
  if (fs.existsSync(reqCuda)) sh(py, ['-m', 'pip', 'install', '-r', reqCuda]);
  // Restaurar rostos (GFPGAN) na GPU: onnxruntime com CUDA 12 no lugar do comum (mesma interface para o faster-whisper)
  sh(py, ['-m', 'pip', 'uninstall', '-y', 'onnxruntime']);
  sh(py, ['-m', 'pip', 'install', 'onnxruntime-gpu==1.23.2']);
}
// "Melhorar qualidade" (aumentar realista + restaurar rostos), em tools/enhance (fora do git)
for (const [file, url] of [
  ['realesr-general-x4v3.pth', 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth'],
  ['gfpgan_1.4.onnx', 'https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/gfpgan_1.4.onnx'],
]) {
  const dest = path.join(root, 'tools', 'enhance', file);
  if (fs.existsSync(dest)) continue;
  console.log(`> baixando ${file}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar ${file}: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}
// Modelo de detecção de rostos (YuNet, OpenCV Zoo, licença MIT) usado no enquadramento automático
const faceModel = path.join(root, 'packages', 'ai-providers', 'python', 'models', 'face_detection_yunet_2023mar.onnx');
if (!fs.existsSync(faceModel)) {
  console.log('> baixando modelo de rostos YuNet (opencv_zoo)');
  fs.mkdirSync(path.dirname(faceModel), { recursive: true });
  const res = await fetch('https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx');
  if (!res.ok) throw new Error(`Falha ao baixar o modelo YuNet: HTTP ${res.status}`);
  fs.writeFileSync(faceModel, Buffer.from(await res.arrayBuffer()));
}
console.log('\nPython pronto. Rode "npm run check-env" para conferir.');
