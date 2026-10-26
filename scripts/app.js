#!/usr/bin/env node
// Modo rápido do app: compila em produção (só quando o código mudou desde o último build) e inicia web + worker.
// No modo dev cada página é compilada no primeiro clique (5–50 s); em produção tudo já vem pronto.
// Uso: npm run app  (npm run app -- --rebuild força um build novo)
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildId = path.join(root, 'apps', 'web', '.next', 'BUILD_ID');

/** Data de modificação mais recente entre os arquivos que entram no build do Next. */
function newestMtime(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const name of fs.readdirSync(p)) {
    if (name === 'node_modules' || name === '.next' || name === 'python' || name.startsWith('.')) continue;
    max = Math.max(max, newestMtime(path.join(p, name)));
  }
  return max;
}

const sources = [
  'apps/web/app',
  'apps/web/components',
  'apps/web/lib',
  'apps/web/next.config.ts',
  'apps/web/postcss.config.mjs',
  'apps/web/tsconfig.json',
  'packages',
  'package.json',
  'package-lock.json',
].map((p) => path.join(root, p));

const builtAt = fs.existsSync(buildId) ? fs.statSync(buildId).mtimeMs : 0;
const changed = Math.max(...sources.map(newestMtime)) > builtAt;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (process.argv.includes('--rebuild') || changed) {
  console.log(builtAt ? 'Código mudou desde o último build: compilando (alguns minutos)...' : 'Primeiro build de produção (alguns minutos)...');
  const r = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
} else {
  console.log('Build de produção em dia: iniciando direto.');
}

const child = spawn(npm, ['run', 'start'], { cwd: root, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
