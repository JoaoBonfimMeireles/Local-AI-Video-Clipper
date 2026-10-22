import fs from 'node:fs';
import path from 'node:path';

const ROOT_PACKAGE_NAME = 'local-ai-video-clipper';
let cachedRoot: string | null = null;

/** Raiz do monorepo: procura para cima o package.json raiz (funciona a partir do Next e do worker). */
export function getRepoRoot(): string {
  if (cachedRoot) return cachedRoot;
  if (process.env.CLIPPER_ROOT) {
    cachedRoot = path.resolve(process.env.CLIPPER_ROOT);
    return cachedRoot;
  }
  let dir = process.cwd();
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name === ROOT_PACKAGE_NAME) {
          cachedRoot = dir;
          return dir;
        }
      } catch {
        // package.json inválido: continua subindo
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Raiz do projeto (${ROOT_PACKAGE_NAME}) não encontrada a partir de ${process.cwd()}`);
}

export function getDataDir(): string {
  const root = getRepoRoot();
  return process.env.DATA_DIR ? path.resolve(root, process.env.DATA_DIR) : path.join(root, 'data');
}

export const dataPaths = {
  get root() {
    return getDataDir();
  },
  get input() {
    return path.join(getDataDir(), 'input');
  },
  get output() {
    return path.join(getDataDir(), 'output');
  },
  get memes() {
    return path.join(getDataDir(), 'memes');
  },
  get audio() {
    return path.join(getDataDir(), 'audio');
  },
  get images() {
    return path.join(getDataDir(), 'images');
  },
  get temp() {
    return path.join(getDataDir(), 'temp');
  },
  get db() {
    return path.join(getDataDir(), 'database.db');
  },
};

export function ensureDataDirs(): void {
  const d = dataPaths;
  const dirs = [
    d.input,
    d.output,
    d.temp,
    d.images,
    path.join(d.memes, 'humor'),
    path.join(d.memes, 'choque'),
    path.join(d.memes, 'reacoes'),
    path.join(d.audio, 'impacto'),
    path.join(d.audio, 'risadas'),
    path.join(d.audio, 'transicao'),
  ];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
}

/** true se `child` está dentro de `parent` (após resolver `..`, links relativos etc.). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Junta um caminho relativo vindo de fora (API/IA) a uma base, recusando qualquer fuga da base. */
export function safeJoin(base: string, relative: string): string {
  if (relative.includes('\0')) throw new Error('Caminho inválido');
  const full = path.resolve(base, relative);
  if (!isInside(base, full)) throw new Error(`Caminho fora da pasta permitida: ${relative}`);
  return full;
}
