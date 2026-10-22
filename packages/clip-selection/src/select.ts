import type { ClipCandidate, ClipSegment } from './scoring';

export function segmentsOf(c: ClipCandidate): ClipSegment[] {
  return c.segments?.length ? c.segments : [{ start: c.start, end: c.end }];
}

export function clipDuration(c: ClipCandidate): number {
  return segmentsOf(c).reduce((a, s) => a + (s.end - s.start), 0);
}

export interface SelectOptions {
  maxClips: number | 'auto';
  videoDuration: number;
  targetDuration: number;
  /** Nota mínima no modo automático. */
  minScore?: number;
  /** Sobreposição máxima tolerada (fração do menor corte). */
  maxOverlap?: number;
  /** Modo automático: garante pelo menos esta quantidade (se houver candidatos sem sobreposição). */
  minClips?: number;
}

function overlap(a: ClipCandidate, b: ClipCandidate): number {
  let inter = 0;
  for (const x of segmentsOf(a)) for (const y of segmentsOf(b)) inter += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return inter / Math.max(0.001, Math.min(clipDuration(a), clipDuration(b)));
}

/** Seleção gulosa por nota, eliminando cortes redundantes (sobrepostos) — estilo NMS. */
export function selectClips<T extends ClipCandidate>(candidates: T[], opts: SelectOptions): T[] {
  const maxOverlap = opts.maxOverlap ?? 0.04;
  const sorted = [...candidates]
    .filter((c) => clipDuration(c) >= 3 && Number.isFinite(c.score))
    .sort((a, b) => b.score - a.score);
  const auto = opts.maxClips === 'auto';
  const cap = auto ? Math.max(1, Math.min(20, Math.floor(opts.videoDuration / Math.max(15, opts.targetDuration) / 1.5) || 1)) : Math.max(1, opts.maxClips as number);
  const minScore = auto ? opts.minScore ?? 55 : 0;

  // Compilações (ex.: Top 5 da live) reaproveitam os melhores momentos de propósito:
  // não competem por sobreposição com os cortes normais nem os eliminam
  const isCompilation = (c: ClipCandidate) => c.category === 'top5';
  const conflicts = (picked: T[], c: T) => !isCompilation(c) && picked.some((p) => !isCompilation(p) && overlap(p, c) > maxOverlap);
  const want = Math.max(cap, auto ? Math.min(opts.minClips ?? 0, 20) : 0);

  const picked: T[] = [];
  for (const c of sorted) {
    if (picked.length >= cap) break;
    if (conflicts(picked, c)) continue;
    if (c.score < minScore && picked.length > 0) continue;
    picked.push(c);
  }
  // Poucos cortes acima da nota mínima: completa com os melhores restantes até o mínimo pedido
  if (auto && picked.length < want) {
    for (const c of sorted) {
      if (picked.length >= want) break;
      if (picked.includes(c) || conflicts(picked, c)) continue;
      picked.push(c);
    }
  }
  return picked.sort((a, b) => a.start - b.start);
}
