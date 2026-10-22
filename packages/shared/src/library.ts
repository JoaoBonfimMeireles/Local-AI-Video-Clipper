import fs from 'node:fs';
import path from 'node:path';
import { dataPaths, isInside } from './paths';
import type { LibraryCategory, LibraryIndex } from './types';

export const MEME_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov'];
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];

export type LibraryKind = keyof LibraryIndex;

function scanKind(base: string, exts: string[]): LibraryCategory[] {
  if (!fs.existsSync(base)) return [];
  const cats: LibraryCategory[] = [];
  const rootFiles: string[] = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const files = fs
        .readdirSync(path.join(base, entry.name), { withFileTypes: true })
        .filter((f) => f.isFile() && exts.includes(path.extname(f.name).toLowerCase()))
        .map((f) => f.name)
        .sort();
      cats.push({ name: entry.name, files });
    } else if (entry.isFile() && exts.includes(path.extname(entry.name).toLowerCase())) {
      rootFiles.push(entry.name);
    }
  }
  if (rootFiles.length) cats.push({ name: '_geral', files: rootFiles.sort() });
  return cats.sort((a, b) => a.name.localeCompare(b.name));
}

export function scanLibrary(): LibraryIndex {
  return {
    memes: scanKind(dataPaths.memes, MEME_EXTENSIONS),
    audio: scanKind(dataPaths.audio, AUDIO_EXTENSIONS),
    images: scanKind(dataPaths.images, IMAGE_EXTENSIONS),
  };
}

export function libraryBaseDir(kind: LibraryKind): string {
  return kind === 'memes' ? dataPaths.memes : kind === 'audio' ? dataPaths.audio : dataPaths.images;
}

/**
 * Resolve um arquivo da biblioteca SOMENTE se ele aparece no índice escaneado.
 * Isso impede que a IA (ou a API) aponte para caminhos arbitrários.
 */
export function resolveLibraryFile(index: LibraryIndex, kind: LibraryKind, category: string, file: string): string | null {
  const cat = index[kind].find((c) => c.name === category);
  if (!cat || !cat.files.includes(file)) return null;
  const base = libraryBaseDir(kind);
  const full = category === '_geral' ? path.join(base, file) : path.join(base, category, file);
  return isInside(base, full) && fs.existsSync(full) ? full : null;
}
