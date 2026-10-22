// Utilitários puros (seguros para o navegador).

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 75.5 -> "01:15.5" / 3725 -> "1:02:05" */
export function formatTimestamp(seconds: number, withMs = false): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secStr = withMs ? sec.toFixed(1).padStart(4, '0') : Math.floor(sec).toString().padStart(2, '0');
  const mm = m.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${secStr}` : `${mm}:${secStr}`;
}

export function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
      .slice(0, 80) || 'video'
  );
}

/**
 * Lista plana de palavras do transcript. O Whisper marca início de palavra com espaço inicial;
 * pedaços sem espaço ("-vindos", "$") são colados à palavra anterior.
 */
export function flattenWords(segments: { words: { start: number; end: number; word: string; probability?: number }[] }[]) {
  const out: { start: number; end: number; word: string; probability?: number }[] = [];
  for (const seg of segments) {
    seg.words.forEach((w, i) => {
      const prev = out[out.length - 1];
      const isPiece = i > 0 && prev && !/^\s/.test(w.word) && w.start - prev.end < 0.3;
      if (isPiece) {
        prev.word += w.word;
        prev.end = w.end;
      } else {
        out.push({ ...w, word: w.word.trim() });
      }
    });
  }
  return out.filter((w) => w.word.length > 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'pt', label: 'Português' },
  { code: 'en', label: 'Inglês' },
  { code: 'es', label: 'Espanhol' },
  { code: 'fr', label: 'Francês' },
  { code: 'de', label: 'Alemão' },
  { code: 'it', label: 'Italiano' },
  { code: 'ja', label: 'Japonês' },
  { code: 'ko', label: 'Coreano' },
  { code: 'zh', label: 'Chinês' },
  { code: 'ru', label: 'Russo' },
  { code: 'ar', label: 'Árabe' },
  { code: 'hi', label: 'Hindi' },
];

export function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
