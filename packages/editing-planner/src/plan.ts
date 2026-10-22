import type { Intensity, JobSettings, LibraryIndex, TranscriptWord } from '@clipper/shared';
import { resolveLibraryFile, type LibraryKind } from '@clipper/shared/server';
import type { ClipEdit, Overlay, Sfx, Zoom } from './schemas';

// ---------------- Limites por intensidade ----------------

const LIMITS: Record<Intensity, { zoomsPerMin: number; memesPerMin: number; sfxPerMin: number; minZoomGap: number }> = {
  low: { zoomsPerMin: 1, memesPerMin: 0, sfxPerMin: 1, minZoomGap: 15 },
  medium: { zoomsPerMin: 8, memesPerMin: 2, sfxPerMin: 4, minZoomGap: 4 },
  high: { zoomsPerMin: 24, memesPerMin: 5, sfxPerMin: 10, minZoomGap: 1.5 },
};

const cap = (perMin: number, duration: number) => Math.max(perMin > 0 ? 1 : 0, Math.round((perMin * duration) / 60));

/** Aplica limites e coerência temporal a um plano (vindo da IA ou da heurística). */
export function normalizeEdit(edit: ClipEdit, duration: number, settings: JobSettings): ClipEdit {
  const lim = LIMITS[settings.intensity];
  const inside = <T extends { at: number }>(x: T) => x.at >= 0 && x.at < duration - 0.3;

  const zooms: Zoom[] = [];
  for (const z of [...edit.zooms].filter(inside).sort((a, b) => a.at - b.at)) {
    const prev = zooms[zooms.length - 1];
    const d = Math.min(z.duration, duration - z.at);
    if (d < 0.3) continue;
    if (prev && z.at < prev.at + prev.duration + (settings.intensity === 'high' ? 0 : 0.5)) continue;
    if (prev && z.at - prev.at < lim.minZoomGap) continue;
    zooms.push({ ...z, duration: d, scale: settings.intensity === 'low' ? Math.min(z.scale, 1.12) : z.scale });
  }

  const overlays: Overlay[] = [];
  if (settings.useMemes) {
    for (const o of [...edit.overlays].filter(inside).sort((a, b) => a.at - b.at)) {
      const prev = overlays[overlays.length - 1];
      if (prev && o.at < prev.at + prev.duration + 0.5) continue; // um meme por vez
      overlays.push({ ...o, duration: Math.min(o.duration, duration - o.at) });
    }
  }

  const sfx: Sfx[] = [];
  if (settings.useSfx) {
    for (const s of [...edit.sfx].filter(inside).sort((a, b) => a.at - b.at)) {
      if (sfx.length && s.at - sfx[sfx.length - 1].at < 0.8) continue;
      sfx.push(s);
    }
  }

  return {
    clipIndex: edit.clipIndex,
    zooms: zooms.slice(0, cap(lim.zoomsPerMin, duration)),
    overlays: overlays.slice(0, cap(lim.memesPerMin, duration)).slice(0, settings.intensity === 'low' ? 0 : 30),
    sfx: sfx.slice(0, cap(lim.sfxPerMin, duration)),
    emphasisWords: edit.emphasisWords.slice(0, 60),
  };
}

// ---------------- Plano heurístico (sem IA / fallback) ----------------

const LAUGH = /^(k{3,}|(ha){2,}|(he){2,}|rs+|hahaha+|risos)/i;
const SURPRISE = /^(absurdo|incrível|incrivel|sério|serio|caramba|nossa|impossível|impossivel|chocante|uau|wow|what|crazy|insane|nunca|ninguém|ninguem)/i;
const STRONG = /^(segredo|verdade|dinheiro|erro|pior|melhor|importante|lição|licao|cuidado|atenção|atencao|polêmica|polemica|nunca|ninguém|ninguem|secret|money|truth|never|mistake)/i;

function seededRandom(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickCategory(lib: LibraryIndex, kind: LibraryKind, preferred: string[]): string | null {
  const nonEmpty = lib[kind].filter((c) => c.files.length);
  for (const p of preferred) if (nonEmpty.some((c) => c.name === p)) return p;
  return nonEmpty[0]?.name ?? null;
}

export function heuristicEdit(args: {
  clipIndex: number;
  words: TranscriptWord[];
  duration: number;
  settings: JobSettings;
  library: LibraryIndex;
  seed: string;
}): ClipEdit {
  const { words, duration, settings, library } = args;
  const rnd = seededRandom(args.seed);
  const intensity = settings.intensity;
  const clean = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, '');

  const emphasis = words.filter((w) => STRONG.test(clean(w.word)) || SURPRISE.test(clean(w.word)) || /!$/.test(w.word) || /\d/.test(w.word));
  const emphasisWords = [...new Set(emphasis.map((w) => clean(w.word).toLowerCase()).filter(Boolean))];

  // Zooms: em palavras de ênfase + ritmo base por intensidade
  const zooms: Zoom[] = [];
  const baseEvery = intensity === 'high' ? 3 : intensity === 'medium' ? 8 : 0;
  const zoomTimes = new Set<number>(emphasis.map((w) => Math.max(0, w.start - 0.15)));
  if (baseEvery) for (let t = 1.5; t < duration - 1; t += baseEvery) zoomTimes.add(t + rnd() * 0.8);
  if (intensity === 'low' && emphasis.length) zoomTimes.clear(), zoomTimes.add(Math.max(0, emphasis[0].start - 0.2));
  let flip = false;
  for (const at of [...zoomTimes].sort((a, b) => a - b)) {
    flip = !flip;
    zooms.push({
      at,
      duration: intensity === 'high' ? 1.6 + rnd() * 1.2 : 2.2 + rnd() * 1.2,
      scale: intensity === 'high' ? (flip ? 1.35 : 1.18) : intensity === 'medium' ? (flip ? 1.22 : 1.15) : 1.1,
      focusX: intensity === 'high' ? 0.4 + rnd() * 0.2 : 0.5,
      focusY: 0.38 + rnd() * 0.08,
    });
  }

  // Memes + sons em picos de humor/surpresa
  const overlays: Overlay[] = [];
  const sfx: Sfx[] = [];
  const memeCatHumor = pickCategory(library, 'memes', ['humor', 'reacoes']);
  const memeCatShock = pickCategory(library, 'memes', ['choque', 'reacoes', 'humor']);
  const sfxLaugh = pickCategory(library, 'audio', ['risadas', 'impacto']);
  const sfxImpact = pickCategory(library, 'audio', ['impacto', 'transicao']);
  const sfxTransition = pickCategory(library, 'audio', ['transicao', 'impacto']);
  const positions: Overlay['position'][] = ['top', 'top-right', 'top-left', 'center'];

  for (const w of words) {
    const word = clean(w.word);
    const kind = LAUGH.test(word) ? 'humor' : SURPRISE.test(word) || /\?!|!\?/.test(w.word) ? 'shock' : null;
    if (!kind) continue;
    const cat = kind === 'humor' ? memeCatHumor : memeCatShock;
    if (cat && intensity !== 'low') {
      overlays.push({
        type: 'meme',
        category: cat,
        file: null,
        at: w.start,
        duration: 1.6,
        position: positions[overlays.length % (intensity === 'high' ? 4 : 2)],
        scale: intensity === 'high' ? 0.55 : 0.45,
      });
    }
    const sCat = kind === 'humor' ? sfxLaugh : sfxImpact;
    if (sCat) sfx.push({ category: sCat, file: null, at: w.start, volume: 0.7 });
  }
  if (intensity !== 'low' && sfxTransition) sfx.unshift({ category: sfxTransition, file: null, at: 0, volume: 0.6 });
  if (intensity === 'high' && sfxImpact) {
    for (const z of zooms.filter((_, i) => i % 3 === 1)) sfx.push({ category: sfxImpact, file: null, at: z.at, volume: 0.45 });
  }
  // Pergunta → reação (alta intensidade)
  if (intensity === 'high' && memeCatShock) {
    for (const w of words.filter((x) => /\?$/.test(x.word))) {
      overlays.push({ type: 'meme', category: memeCatShock, file: null, at: w.end, duration: 1.4, position: 'top', scale: 0.5 });
    }
  }

  return normalizeEdit(
    { clipIndex: args.clipIndex, zooms, overlays: overlays.sort((a, b) => a.at - b.at), sfx: sfx.sort((a, b) => a.at - b.at), emphasisWords },
    duration,
    settings,
  );
}

// ---------------- Resolução segura de assets ----------------

export interface ResolvedOverlay extends Omit<Overlay, 'file'> {
  file: string;
  fileName: string;
}
export interface ResolvedSfx extends Omit<Sfx, 'file'> {
  file: string;
  fileName: string;
}
export interface ResolvedEdit {
  clipIndex: number;
  zooms: Zoom[];
  overlays: ResolvedOverlay[];
  sfx: ResolvedSfx[];
  emphasisWords: string[];
  warnings: string[];
}

/**
 * Converte nomes (categoria/arquivo) do plano em caminhos absolutos — somente arquivos que existem
 * no índice escaneado da biblioteca. Arquivo inexistente → sorteia outro da mesma categoria.
 */
export function resolveEdit(edit: ClipEdit, library: LibraryIndex, seed: string): ResolvedEdit {
  const rnd = seededRandom(seed);
  const warnings: string[] = [];
  const pick = (kind: LibraryKind, category: string, file?: string | null): { file: string; fileName: string; category: string } | null => {
    let cat = library[kind].find((c) => c.name === category && c.files.length);
    if (!cat) {
      const fallback = library[kind].filter((c) => c.files.length);
      if (!fallback.length) return null;
      warnings.push(`categoria "${category}" inexistente em ${kind}; usando "${fallback[0].name}"`);
      cat = fallback[Math.floor(rnd() * fallback.length)];
    }
    let name = file && cat.files.includes(file) ? file : null;
    if (file && !name) warnings.push(`arquivo "${file}" não encontrado em ${kind}/${cat.name}; sorteando outro`);
    if (!name) {
      // Arquivos de vídeo/áudio pesados só para memes; images aceita qualquer imagem
      name = cat.files[Math.floor(rnd() * cat.files.length)];
    }
    const full = resolveLibraryFile(library, kind, cat.name, name);
    return full ? { file: full, fileName: name, category: cat.name } : null;
  };

  const overlays: ResolvedOverlay[] = [];
  for (const o of edit.overlays) {
    const r = pick(o.type === 'image' ? 'images' : 'memes', o.category, o.file);
    if (r) overlays.push({ ...o, category: r.category, file: r.file, fileName: r.fileName });
  }
  const sfx: ResolvedSfx[] = [];
  for (const s of edit.sfx) {
    const r = pick('audio', s.category, s.file);
    if (r) sfx.push({ ...s, category: r.category, file: r.file, fileName: r.fileName });
  }
  return { clipIndex: edit.clipIndex, zooms: edit.zooms, overlays, sfx, emphasisWords: edit.emphasisWords, warnings };
}
