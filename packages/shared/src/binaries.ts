// Localiza FFmpeg/FFprobe/Python sem depender do PATH atualizado (mesma lógica de scripts/lib/binaries.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEnvValue } from './env';
import { getRepoRoot } from './paths';

const isWin = process.platform === 'win32';
const exe = (name: string) => (isWin ? `${name}.exe` : name);
const cache = new Map<string, string>();

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, exe(name));
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function findInWinget(name: string): string | null {
  if (!isWin) return null;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const link = path.join(local, 'Microsoft', 'WinGet', 'Links', exe(name));
  if (fs.existsSync(link)) return link;
  const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  if (!fs.existsSync(pkgs)) return null;
  for (const pkg of fs.readdirSync(pkgs)) {
    if (!/ffmpeg/i.test(pkg)) continue;
    for (const sub of fs.readdirSync(path.join(pkgs, pkg))) {
      const candidate = path.join(pkgs, pkg, sub, 'bin', exe(name));
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveBinary(name: 'ffmpeg' | 'ffprobe'): string {
  const cached = cache.get(name);
  if (cached) return cached;
  const fromEnv = getEnvValue(name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH');
  const found = (fromEnv && fs.existsSync(fromEnv) ? fromEnv : null) ?? findOnPath(name) ?? findInWinget(name);
  if (!found) throw new Error(`${name} não encontrado. Instale (winget install Gyan.FFmpeg) ou defina ${name.toUpperCase()}_PATH.`);
  cache.set(name, found);
  return found;
}

export function resolvePythonBinary(): string {
  const fromEnv = getEnvValue('PYTHON_PATH');
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const root = getRepoRoot();
  const venv = isWin ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  throw new Error('Python (.venv) não encontrado. Rode: npm run setup:python');
}

export function pythonScriptPath(script: string): string {
  return path.join(getRepoRoot(), 'packages', 'ai-providers', 'python', script);
}

/** Real-ESRGAN (realesrgan-ncnn-vulkan): REALESRGAN_PATH ou tools/realesrgan/ do projeto. Os modelos ficam em models/ ao lado. */
export function resolveRealesrgan(): { exe: string; models: string } {
  const fromEnv = getEnvValue('REALESRGAN_PATH');
  const exePath = fromEnv && fs.existsSync(fromEnv) ? fromEnv : path.join(getRepoRoot(), 'tools', 'realesrgan', exe('realesrgan-ncnn-vulkan'));
  if (!fs.existsSync(exePath)) {
    throw new Error('Real-ESRGAN não encontrado. Baixe realesrgan-ncnn-vulkan (github.com/xinntao/Real-ESRGAN/releases) e extraia em tools/realesrgan, ou defina REALESRGAN_PATH.');
  }
  return { exe: exePath, models: path.join(path.dirname(exePath), 'models') };
}
