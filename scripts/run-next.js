#!/usr/bin/env node
// Executa o Next.js com o shim de exFAT pré-carregado (também nos processos-filhos do Next,
// via NODE_OPTIONS). Uso: node scripts/run-next.js <dev|build|start> [args...]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// NODE_OPTIONS interpreta "\" como escape: usa barras normais (aceitas pelo Node no Windows)
const shim = path.join(root, 'scripts', 'exfat-fs-shim.cjs').replace(/\\/g, '/');
const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');

// O build do webpack passa de 4 GB (limite padrão do heap do Node): libera até 8 GB só para ele.
const heap = process.argv[2] === 'build' ? ' --max-old-space-size=8192' : '';
const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${shim}"${heap}`.trim() };
const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: root });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
// No dev, pré-compila as páginas em segundo plano para o primeiro clique em cada tela não travar.
if (process.argv[2] === 'dev' && !process.env.NO_WARMUP) {
  const p = process.argv.indexOf('-p');
  const port = p > 0 ? process.argv[p + 1] : '3000';
  spawn(process.execPath, [path.join(root, 'scripts', 'warmup.js')], { stdio: 'inherit', env: { ...process.env, WARMUP_URL: `http://localhost:${port}` } });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
