// Localiza binários externos (FFmpeg, Python) sem depender do PATH estar atualizado.
// Usado pelo check-env e espelhado em packages/video-processing/src/bin.ts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const isWin = process.platform === 'win32';
const exe = (name) => (isWin ? `${name}.exe` : name);

export function findOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const full = path.join(dir, exe(name));
    if (dir && fs.existsSync(full)) return full;
  }
  return null;
}

function findInWinget(name) {
  if (!isWin) return null;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const link = path.join(local, 'Microsoft', 'WinGet', 'Links', exe(name));
  if (fs.existsSync(link)) return link;
  const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
  if (!fs.existsSync(pkgs)) return null;
  for (const pkg of fs.readdirSync(pkgs)) {
    if (!/ffmpeg/i.test(pkg)) continue;
    const pkgDir = path.join(pkgs, pkg);
    for (const sub of fs.readdirSync(pkgDir)) {
      const candidate = path.join(pkgDir, sub, 'bin', exe(name));
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveFfmpegBinary(name /* 'ffmpeg' | 'ffprobe' */) {
  const envKey = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) return process.env[envKey];
  return findOnPath(name) || findInWinget(name);
}

export function resolvePython(root) {
  if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) return process.env.PYTHON_PATH;
  const venv = isWin ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return null;
}

/** Python do sistema (para criar o venv). Ignora o alias falso da Microsoft Store. */
export function resolveSystemPython() {
  if (isWin) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const base = path.join(local, 'Programs', 'Python');
    if (fs.existsSync(base)) {
      const versions = fs
        .readdirSync(base)
        .filter((d) => /^Python3\d+$/.test(d))
        .sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));
      for (const v of versions) {
        const p = path.join(base, v, 'python.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  }
  for (const name of ['python3', 'python']) {
    const p = findOnPath(name);
    if (p && !p.includes('WindowsApps')) return p;
  }
  return null;
}
