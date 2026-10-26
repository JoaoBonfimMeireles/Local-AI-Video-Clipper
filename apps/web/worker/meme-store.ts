// Projetos do canal de memes (data/meme-studio/projects/<id>.json) e a identidade do canal (brand.json).
// Leve: usado pelo worker e pela API.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MEME_BRAND, type MemeBrand, type MemeProject } from '@clipper/shared';
import { dataPaths } from '@clipper/shared/server';

export const memeDir = () => path.join(dataPaths.root, 'meme-studio');
/** Logos, imagens e sons enviados pelo painel de memes. */
export const memeAssetsDir = () => path.join(memeDir(), 'assets');
const projectFile = (id: string) => path.join(memeDir(), 'projects', `${path.basename(id)}.json`);
const brandFile = () => path.join(memeDir(), 'brand.json');

export function listMemeProjects(): MemeProject[] {
  const dir = path.join(memeDir(), 'projects');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as MemeProject)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readMemeProject(id: string): MemeProject | null {
  const f = projectFile(id);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as MemeProject) : null;
}

export function writeMemeProject(p: MemeProject): void {
  fs.mkdirSync(path.dirname(projectFile(p.id)), { recursive: true });
  fs.writeFileSync(projectFile(p.id), JSON.stringify(p, null, 2), 'utf8');
}

export function deleteMemeProject(id: string): boolean {
  const f = projectFile(id);
  if (!fs.existsSync(f)) return false;
  fs.rmSync(f);
  return true;
}

export function readMemeBrand(): MemeBrand {
  const f = brandFile();
  return fs.existsSync(f) ? { ...DEFAULT_MEME_BRAND, ...(JSON.parse(fs.readFileSync(f, 'utf8')) as Partial<MemeBrand>) } : DEFAULT_MEME_BRAND;
}

export function writeMemeBrand(b: MemeBrand): void {
  fs.mkdirSync(memeDir(), { recursive: true });
  fs.writeFileSync(brandFile(), JSON.stringify(b, null, 2), 'utf8');
}
