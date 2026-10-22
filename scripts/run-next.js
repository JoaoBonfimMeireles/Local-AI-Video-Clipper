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

const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${shim}"`.trim() };
const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: root });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
