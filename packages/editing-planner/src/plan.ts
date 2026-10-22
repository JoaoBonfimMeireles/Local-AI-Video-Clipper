import type { Intensity, JobSettings, LibraryIndex, TranscriptWord } from '@clipper/shared';
import { resolveLibraryFile, type LibraryKind } from '@clipper/shared/server';
import type { ClipEdit, Overlay, Sfx, Shot, Zoom } from './schemas';
import { findAssetsByKeywords, matchAssetByName } from './library-select';

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
    shots: normalizeShots(edit.shots ?? [], duration),
    zooms: zooms.slice(0, cap(lim.zoomsPerMin, duration)),
    overlays: overlays.slice(0, cap(lim.memesPerMin, duration)).slice(0, settings.intensity === 'low' ? 0 : 30),
    sfx: sfx.slice(0, cap(lim.sfxPerMin, duration)),
    emphasisWords: edit.emphasisWords.slice(0, 60),
    title: edit.title,
    description: edit.description,
    hashtags: edit.hashtags ?? [],
  };
}

/**
 * Deixa os enquadramentos contínuos (cada um vai até o início do próximo), descarta trocas com
 * menos de 1s (piscadas de câmera) e garante cobertura até o fim do corte.
 */
export function normalizeShots(shots: Shot[], duration: number): Shot[] {
  const sorted = [...shots].filter((x) => x.at < duration - 0.5).sort((a, b) => a.at - b.at);
  const out: Shot[] = [];
  for (const sh of sorted) {
    const prev = out[out.length - 1];
    if (prev && sh.at - prev.at < 1) {
      out[out.length - 1] = { ...sh, at: prev.at };
      continue;
    }
    out.push({ ...sh, at: out.length === 0 ? 0 : sh.at });
  }
  return out.map((sh, i) => ({ ...sh, duration: (out[i + 1]?.at ?? duration) - sh.at }));
}

const pickBox = (f: { x: number; y: number; w: number; h: number }) => ({ x: f.x, y: f.y, w: f.w, h: f.h });

export interface FrameFaces {
  /** Tempo na linha do tempo do corte. */
  time: number;
  faces: { x: number; y: number; w: number; h: number }[];
}

/**
 * Combina a decisão da IA (QUEM/O QUE enquadrar) com a detecção local de rostos (ONDE está):
 * 1. divide shots nos cortes de câmera do vídeo original (o conteúdo muda de lugar a cada corte);
 * 2. ajusta focusX/focusY de cada shot "focus" ao rosto mais próximo do que a IA apontou;
 * 3. se o vídeo original já está em close (rosto grande), não aproxima mais (evita rosto cortado);
 * 4. sem rosto perto do alvo e com aproximação forte (comida/objeto), mantém a escolha da IA.
 */
export function refineShots(shots: Shot[], ctx: { duration: number; cuts: number[]; frames: FrameFaces[] }): Shot[] {
  if (!shots.length) return shots;
  const cuts = ctx.cuts.filter((c) => c > 0.5 && c < ctx.duration - 0.5).sort((a, b) => a - b);
  const split: Shot[] = [];
  for (const sh of normalizeShots(shots, ctx.duration)) {
    const end = sh.at + sh.duration;
    let at = sh.at;
    for (const c of cuts) {
      if (c > at + 0.8 && c < end - 0.8) {
        split.push({ ...sh, at, duration: c - at });
        at = c;
      }
    }
    split.push({ ...sh, at, duration: end - at });
  }

  const refined = split.map((sh) => {
    if (sh.type === 'wide') {
      // Plano aberto: só a faixa que contém todas as pessoas (ficam maiores no 9:16), sem cortar ninguém
      const faces = ctx.frames.filter((f) => f.time >= sh.at && f.time < sh.at + sh.duration).slice(0, 3).flatMap((f) => f.faces);
      if (faces.length < 2) return sh;
      const x0 = Math.max(0, Math.min(...faces.map((f) => f.x - f.w * 1.7)));
      const x1 = Math.min(1, Math.max(...faces.map((f) => f.x + f.w * 1.7)));
      return x1 - x0 < 0.95 ? { ...sh, group: { x0, x1 } } : sh;
    }
    if (sh.type !== 'focus') return sh;
    // Frames logo após o início do shot representam o que está na tela nele
    const inWindow = ctx.frames.filter((f) => f.time >= sh.at && f.time < sh.at + sh.duration);
    const sample = inWindow.slice(0, 3).flatMap((f) => f.faces);
    if (!sample.length) return sh;
    const isObject = sh.scale >= 1.4 && sh.focusY >= 0.6;
    const nearest = sample.reduce((best, f) => (Math.abs(f.x - sh.focusX) < Math.abs(best.x - sh.focusX) ? f : best));
    if (Math.abs(nearest.x - sh.focusX) > (isObject ? 0.12 : 0.3)) {
      // A IA mirou algo que não é rosto (comida, objeto) ou um lugar vazio
      if (isObject) return sh;
      const biggest = sample.reduce((a, b) => (b.w > a.w ? b : a));
      return { ...sh, focusX: biggest.x, focusY: Math.min(0.9, biggest.y + biggest.h * 0.6), scale: biggest.w > 0.2 ? 1 : sh.scale, subject: pickBox(biggest) };
    }
    const closeUp = nearest.w > 0.2;
    return {
      ...sh,
      focusX: nearest.x,
      // Rosto no terço superior: centraliza um pouco abaixo dele
      focusY: Math.min(0.9, nearest.y + nearest.h * 0.6),
      scale: closeUp ? 1 : Math.min(sh.scale, 1.6),
      subject: pickBox(nearest),
    };
  });
  return normalizeShots(refined, ctx.duration);
}

/** Enquadramento sem IA: a cada cena do vídeo original, foca no rosto principal (ou abre se há vários). */
export function heuristicShots(ctx: { duration: number; cuts: number[]; frames: FrameFaces[]; preferWide: boolean }): Shot[] {
  const bounds = [0, ...ctx.cuts.filter((c) => c > 0.5 && c < ctx.duration - 0.5).sort((a, b) => a - b), ctx.duration];
  const shots: Shot[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const faces = ctx.frames.filter((f) => f.time >= bounds[i] && f.time < bounds[i + 1]).slice(0, 2).flatMap((f) => f.faces);
    if (!faces.length) continue;
    const distinct = new Set(faces.map((f) => Math.round(f.x * 4))).size;
    const big = faces.reduce((a, b) => (b.w > a.w ? b : a));
    if (distinct > 1 && ctx.preferWide) shots.push({ at: bounds[i], duration: bounds[i + 1] - bounds[i], type: 'wide', focusX: 0.5, focusY: 0.45, scale: 1 });
    else shots.push({ at: bounds[i], duration: bounds[i + 1] - bounds[i], type: 'focus', focusX: big.x, focusY: Math.min(0.9, big.y + big.h * 0.6), scale: 1, subject: pickBox(big) });
  }
  return normalizeShots(shots, ctx.duration);
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

  // Memes + sons em picos de humor/surpresa — escolhidos pelo NOME do arquivo (funciona com pasta única)
  const overlays: Overlay[] = [];
  const sfx: Sfx[] = [];
  const used = new Set<string>();
  const choose = (kind: LibraryKind, keywords: string[]): { category: string; file: string } | null => {
    const found = findAssetsByKeywords(library, kind, keywords).filter((a) => !used.has(a.file));
    if (!found.length) return null;
    const top = found.slice(0, 6);
    const pick = top[Math.floor(rnd() * top.length)];
    used.add(pick.file);
    return pick;
  };
  const LAUGH_KEYS = ['laugh', 'laughing', 'lol', 'haha', 'funny', 'risada', 'risadas', 'humor', 'kkk'];
  const SHOCK_KEYS = ['shocked', 'shock', 'wow', 'omg', 'surprised', 'what', 'choque', 'reacoes', 'dramatic'];
  const IMPACT_KEYS = ['boom', 'vine', 'impact', 'hit', 'bruh', 'impacto', 'ding'];
  const TRANSITION_KEYS = ['whoosh', 'swoosh', 'transition', 'transicao', 'woosh'];
  const positions: Overlay['position'][] = ['top', 'top-right', 'top-left', 'center'];

  for (const w of words) {
    const word = clean(w.word);
    const kind = LAUGH.test(word) ? 'humor' : SURPRISE.test(word) || /\?!|!\?/.test(w.word) ? 'shock' : null;
    if (!kind) continue;
    const meme = intensity !== 'low' ? choose('memes', kind === 'humor' ? LAUGH_KEYS : SHOCK_KEYS) : null;
    if (meme) {
      overlays.push({
        type: 'meme',
        category: meme.category,
        file: meme.file,
        at: w.start,
        duration: 1.6,
        position: positions[overlays.length % (intensity === 'high' ? 4 : 2)],
        scale: intensity === 'high' ? 0.55 : 0.45,
        audioMode: 'both',
      });
    }
    const snd = choose('audio', kind === 'humor' ? LAUGH_KEYS : IMPACT_KEYS);
    if (snd) sfx.push({ category: snd.category, file: snd.file, at: w.start, volume: 0.7 });
  }
  const whoosh = intensity !== 'low' ? choose('audio', TRANSITION_KEYS) : null;
  if (whoosh) sfx.unshift({ category: whoosh.category, file: whoosh.file, at: 0, volume: 0.6 });
  if (intensity === 'high') {
    for (const z of zooms.filter((_, i) => i % 3 === 1)) {
      const hit = choose('audio', IMPACT_KEYS);
      if (hit) sfx.push({ category: hit.category, file: hit.file, at: z.at, volume: 0.45 });
    }
    // Pergunta → reação
    for (const w of words.filter((x) => /\?$/.test(x.word))) {
      const r = choose('memes', SHOCK_KEYS);
      if (r) overlays.push({ type: 'meme', category: r.category, file: r.file, at: w.end, duration: 1.4, position: 'top', scale: 0.5, audioMode: 'both' });
    }
  }
  return normalizeEdit(
    { clipIndex: args.clipIndex, zooms, overlays: overlays.sort((a, b) => a.at - b.at), sfx: sfx.sort((a, b) => a.at - b.at), emphasisWords, hashtags: [], shots: [] },
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
/** Layout de um corte de live: facecam (caixa no quadro original) ou gameplay sem facecam. */
export interface ClipLayout {
  cam: { x0: number; y0: number; x1: number; y1: number } | null;
  gameplay: boolean;
}

export interface ResolvedEdit {
  clipIndex: number;
  layout?: ClipLayout;
  shots: Shot[];
  zooms: Zoom[];
  overlays: ResolvedOverlay[];
  sfx: ResolvedSfx[];
  emphasisWords: string[];
  title?: string;
  description?: string;
  hashtags: string[];
  warnings: string[];
}

/**
 * Converte o plano em caminhos absolutos — somente arquivos que existem no índice da biblioteca.
 * Nome exato → usa; nome parecido (IA errou a grafia) → usa o mais próximo; sem correspondência → descarta
 * (nunca sorteia um meme qualquer para um momento que pediu outro). Sem arquivo (plano heurístico antigo
 * por categoria) → sorteia dentro da categoria pedida.
 */
export function resolveEdit(edit: ClipEdit, library: LibraryIndex, seed: string): ResolvedEdit {
  const rnd = seededRandom(seed);
  const warnings: string[] = [];
  const pick = (kind: LibraryKind, category: string, file?: string | null): { file: string; fileName: string; category: string } | null => {
    let found: { category: string; file: string } | null = null;
    if (file) {
      const exact = library[kind].find((c) => c.name === category && c.files.includes(file)) ?? library[kind].find((c) => c.files.includes(file));
      if (exact) found = { category: exact.name, file };
      else {
        const near = matchAssetByName(library, kind, file);
        if (near && near.score >= 0.5) {
          warnings.push(`"${file}" não existe; usando o parecido "${near.file}"`);
          found = near;
        } else {
          warnings.push(`"${file}" não existe em ${kind}; descartado`);
          return null;
        }
      }
    } else {
      const cat = library[kind].find((c) => c.name === category && c.files.length);
      if (!cat) return null;
      found = { category: cat.name, file: cat.files[Math.floor(rnd() * cat.files.length)] };
    }
    const full = resolveLibraryFile(library, kind, found.category, found.file);
    return full ? { file: full, fileName: found.file, category: found.category } : null;
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
  return {
    clipIndex: edit.clipIndex,
    shots: edit.shots ?? [],
    zooms: edit.zooms,
    overlays,
    sfx,
    emphasisWords: edit.emphasisWords,
    title: edit.title,
    description: edit.description,
    hashtags: edit.hashtags ?? [],
    warnings,
  };
}

/**
 * Facecam de live: um rosto PEQUENO que aparece na mesma posição, perto de uma borda/canto, na maioria
 * dos frames amostrados. Retorna a caixa estimada da câmera (frações do quadro) ou null (IRL, sem cam).
 */
export function detectFacecam(
  framesFaces: { x: number; y: number; w: number; h: number }[][],
  /** Fração mínima dos frames em que a facecam precisa aparecer (num corte, use alta: ela tem de estar lá o tempo todo). */
  minShare = 0.4,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const valid = framesFaces.filter((f) => f.length);
  if (framesFaces.length < 4 || valid.length < framesFaces.length * Math.min(0.35, minShare)) return null;
  const buckets = new Map<string, { x: number; y: number; w: number; h: number }[]>();
  for (const faces of framesFaces) {
    const seen = new Set<string>();
    for (const f of faces) {
      if (f.w > 0.16) continue; // rosto grande = câmera principal (IRL/podcast), não facecam
      const key = `${Math.round(f.x * 8)}:${Math.round(f.y * 8)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      buckets.set(key, [...(buckets.get(key) ?? []), f]);
    }
  }
  const best = [...buckets.values()].sort((a, b) => b.length - a.length)[0];
  if (!best || best.length < framesFaces.length * minShare) return null;
  const med = (k: 'x' | 'y' | 'w' | 'h') => best.map((f) => f[k]).sort((a, b) => a - b)[Math.floor(best.length / 2)];
  const cx = med('x');
  const cy = med('y');
  const fw = med('w');
  const fh = med('h');
  const nearEdge = cx < 0.33 || cx > 0.67 || cy < 0.3 || cy > 0.7;
  if (!nearEdge) return null;
  // Webcam típica: rosto ocupa ~30% da largura da câmera
  const w = fw * 3.4;
  const h = fh * 3.0;
  const ccy = cy + h * 0.08;
  return {
    x0: Math.max(0, cx - w / 2),
    y0: Math.max(0, ccy - h / 2),
    x1: Math.min(1, cx + w / 2),
    y1: Math.min(1, ccy + h / 2),
  };
}
