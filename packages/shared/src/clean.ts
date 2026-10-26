// "Limpar vídeo": o que tirar de um vídeo baixado antes de mandá-lo para o editor.
// Tempos em segundos do vídeo original; áreas em frações (0..1) do quadro.

export interface CleanBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CleanSpec {
  /** Nome do arquivo em data/input. */
  file: string;
  /** Trechos a cortar fora (partes de outras pessoas, memes inseridos...). */
  cuts: { start: number; end: number }[];
  /** Tira as pausas sem fala mais longas que minSilence segundos. */
  trimSilence: boolean;
  minSilence: number;
  /** Separa a voz da música com o Demucs e mantém só a voz. */
  removeMusic: boolean;
  /** Apaga a legenda queimada. subtitleBand null = detecta a faixa sozinho. */
  removeSubtitles: boolean;
  subtitleBand: { y: number; h: number } | null;
  /** Marcas d'água / logos a borrar-preencher (delogo). */
  logos: CleanBox[];
  /** Recorta faixas pretas nas bordas. */
  cropBlackBars: boolean;
  /** Reduz chiado/ruído de fundo. */
  denoise: boolean;
  /** Volume padrão de redes sociais (-14 LUFS). */
  normalizeAudio: boolean;
  /** Gera também, para baixar separado: só a voz, só a música, o vídeo sem som e os trechos cortados. */
  exportStems: boolean;
}

/** Arquivos extras de "Separar em faixas" (caminhos absolutos). */
export interface CleanStems {
  voice?: string;
  music?: string;
  silentVideo?: string;
  cutouts?: string;
}

export const DEFAULT_CLEAN_SPEC: Omit<CleanSpec, 'file'> = {
  cuts: [],
  trimSilence: false,
  minSilence: 0.8,
  removeMusic: false,
  removeSubtitles: false,
  subtitleBand: null,
  logos: [],
  cropBlackBars: false,
  denoise: false,
  normalizeAudio: true,
  exportStems: false,
};

/** Trechos mantidos: [0, duração] menos os cortes (unidos e ordenados). */
export function keptSegments(duration: number, cuts: { start: number; end: number }[], minLen = 0.05): { start: number; end: number }[] {
  const sorted = cuts
    .map((c) => ({ start: Math.max(0, Math.min(c.start, c.end)), end: Math.min(duration, Math.max(c.start, c.end)) }))
    .filter((c) => c.end - c.start > 0.01)
    .sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  let t = 0;
  for (const c of sorted) {
    if (c.start > t) out.push({ start: t, end: c.start });
    t = Math.max(t, c.end);
  }
  if (t < duration) out.push({ start: t, end: duration });
  return out.filter((s) => s.end - s.start >= minLen);
}
