import fs from 'node:fs';
import path from 'node:path';
import { getRepoRoot } from './paths';

/** Chaves que a UI pode gravar em .env.local. Nada fora desta lista é aceito. */
export const SECRET_KEYS = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

function envFilePath(): string {
  return path.join(getRepoRoot(), '.env.local');
}

function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readEnvFile(): Record<string, string> {
  const file = envFilePath();
  if (!fs.existsSync(file)) return {};
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

/** Carrega .env.local da raiz em process.env (sem sobrescrever variáveis já definidas no shell). */
export function loadRootEnv(): void {
  for (const [k, v] of Object.entries(readEnvFile())) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/** Lê o valor atual direto do arquivo (para que chaves salvas pela UI valham sem reiniciar o worker). */
export function getEnvValue(key: string): string | undefined {
  const fromFile = readEnvFile()[key];
  if (fromFile) return fromFile;
  return process.env[key] || undefined;
}

/** Atualiza (ou remove, com valor vazio) chaves em .env.local preservando o resto do arquivo. */
export function writeEnvValues(updates: Partial<Record<SecretKey, string>>): void {
  const file = envFilePath();
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates).filter(([k]) => (SECRET_KEYS as readonly string[]).includes(k)));

  const next: string[] = [];
  for (const line of lines) {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && pending.has(m[1])) {
      const value = pending.get(m[1])!;
      pending.delete(m[1]);
      if (value) next.push(`${m[1]}=${sanitizeEnvValue(value)}`);
      continue;
    }
    next.push(line);
  }
  for (const [k, v] of pending) if (v) next.push(`${k}=${sanitizeEnvValue(v)}`);
  while (next.length && next[next.length - 1] === '') next.pop();
  fs.writeFileSync(file, next.join('\n') + '\n', 'utf8');
}

function sanitizeEnvValue(v: string): string {
  return v.replace(/[\r\n]/g, '').trim();
}
