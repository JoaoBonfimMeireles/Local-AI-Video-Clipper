// Canal de memes: projeto de compilado (vídeos curtos em sequência) editado à mão no painel /memes.
// O molde do canal (logo em cima, título, vídeo numa moldura arredondada) é calculado aqui, igual na prévia e no render.
// Este arquivo não pode importar módulos Node (é usado pela UI).

/** Um vídeo do compilado, aparado (s do arquivo original). */
export interface MemeClip {
  id: string;
  /** Nome do arquivo em data/input. */
  file: string;
  start: number;
  end: number;
  /** Duração total do arquivo (para os limites do corte). */
  sourceDuration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  /** Volume do áudio do próprio vídeo (0 = mudo, 1 = normal). */
  volume: number;
}

/** Imagem por cima do vídeo: centro (x, y) e largura em frações do quadro 9:16; tempos do compilado. */
export interface MemeImage {
  id: string;
  /** Caminho absoluto (data/meme-studio/assets ou biblioteca de memes/imagens). */
  file: string;
  at: number;
  duration: number;
  x: number;
  y: number;
  w: number;
  /** Proporção largura/altura da imagem. */
  aspect: number;
}

/** Efeito sonoro pontual (tempo do compilado). */
export interface MemeSfx {
  id: string;
  file: string;
  at: number;
  volume: number;
  duration: number;
}

/** Áudio de fundo: música ou o áudio de outro vídeo, do começo do compilado até o fim (em loop). */
export interface MemeMusic {
  file: string;
  /** Onde o áudio começa no arquivo (s). */
  offset: number;
  volume: number;
}

/** Trecho em que o título aparece (tempo do compilado). */
export interface MemeSpan {
  id: string;
  at: number;
  end: number;
}

/** Legenda de um vídeo do compilado (tempos relativos ao início do corte). */
export interface MemeCue {
  start: number;
  end: number;
  text: string;
}

export interface MemeProject {
  id: string;
  name: string;
  title: string;
  /** all: título no vídeo todo; spans: só nos trechos marcados. */
  titleMode: 'all' | 'spans';
  titleSpans: MemeSpan[];
  clips: MemeClip[];
  images: MemeImage[];
  sfx: MemeSfx[];
  music: MemeMusic | null;
  /** Queima a legenda da fala (whisper) no vídeo. */
  subtitles: boolean;
  /** Legendas por vídeo (chave: `${file}|${start}|${end}`), geradas pelo whisper. */
  cues: Record<string, MemeCue[]>;
  /** Último render: vídeo em data/output/memes e legendas por idioma (SRT). */
  lastRender?: { video: string; captions: Record<string, string>; at: string; jobId: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** Identidade do canal, guardada para os próximos vídeos (data/meme-studio/brand.json). */
export interface MemeBrand {
  logo: string | null;
  logoAspect: number;
  /** Fundo do quadro 9:16 e cor da moldura do vídeo. */
  background: string;
  frame: string;
  titleColor: string;
  /** Onde fica a logo, e a altura dela (fração da altura do quadro). */
  logoPos: 'top' | 'bottom' | 'hidden';
  logoSize: number;
  /** Logo animada (GIF/APNG) parada no primeiro quadro (para animações com quadros cortados). */
  logoStill: boolean;
  /** Primeiro quadro da logo (gerado pela API quando logoStill). */
  logoStillFile?: string | null;
  /** Tamanho do título (1 = padrão). */
  titleScale: number;
  /** Largura do vídeo (fração do quadro). */
  videoWidth: number;
  /** Moldura colorida em volta do vídeo, e o arredondamento dos cantos (fração da largura; 0 = reto). */
  showFrame: boolean;
  radius: number;
  /** Desce tudo (logo/título/vídeo) a partir do topo. */
  offsetY: number;
}

export const DEFAULT_MEME_BRAND: MemeBrand = {
  logo: null,
  logoAspect: 1,
  background: '#120a1c',
  frame: '#e07a3a',
  titleColor: '#ffffff',
  logoPos: 'top',
  logoSize: 0.08,
  logoStill: false,
  titleScale: 1,
  videoWidth: 0.9,
  showFrame: true,
  radius: 0.045,
  offsetY: 0,
};

export const MEME_W = 1080;
export const MEME_H = 1920;

/** Medidas fixas do molde (frações do quadro). */
export const MEME_LAYOUT = {
  /** Margem de cima/baixo e espaço entre logo, título e vídeo. */
  margin: 0.03,
  gap: 0.018,
  border: 0.008,
  /** Tamanho base da fonte do título e da legenda (fração da largura). */
  titleSize: 0.068,
  captionSize: 0.058,
};

export const cueKey = (c: Pick<MemeClip, 'file' | 'start' | 'end'>) => `${c.file}|${c.start.toFixed(2)}|${c.end.toFixed(2)}`;
export const clipLength = (c: MemeClip) => Math.max(0.1, c.end - c.start);
export const memeDuration = (p: Pick<MemeProject, 'clips'>) => p.clips.reduce((a, c) => a + clipLength(c), 0);

/** Início de cada vídeo no compilado. */
export function clipOffsets(clips: MemeClip[]): number[] {
  let t = 0;
  return clips.map((c) => {
    const o = t;
    t += clipLength(c);
    return o;
  });
}

/** Título visível no instante t? */
export function titleVisible(p: Pick<MemeProject, 'titleMode' | 'titleSpans' | 'title'>, t: number): boolean {
  if (!p.title.trim()) return false;
  return p.titleMode === 'all' || p.titleSpans.some((s) => t >= s.at && t < s.end);
}

/** Quebra em linhas equilibradas de até `max` caracteres. */
export function wrapMemeText(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Linhas e tamanho do título (fração da largura): até 3 linhas, encolhendo se precisar. */
export function memeTitleLayout(title: string, scale = 1): { lines: string[]; size: number } {
  let size = MEME_LAYOUT.titleSize * scale;
  for (;;) {
    // ~0.62 da altura da fonte por caractere em Arial Black, em 90% da largura
    const max = Math.max(6, Math.floor(0.9 / (size * 0.62)));
    const lines = wrapMemeText(title, max);
    if (lines.length <= 3 || size <= 0.03) return { lines, size };
    size *= 0.92;
  }
}

export interface MemeBox {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/**
 * Posições do molde para um vídeo de proporção width/height (frações do quadro), iguais na prévia e no render.
 * Empilha de cima para baixo: [logo] → título → vídeo; com a logo embaixo, ela fica colada na margem de baixo.
 * O vídeo usa `videoWidth` da largura e encolhe se não couber na altura que sobra (deixando espaço da legenda).
 */
export function memeLayout(b: MemeBrand, title: string, width: number, height: number) {
  const L = MEME_LAYOUT;
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  const hasLogo = !!b.logo && b.logoPos !== 'hidden';
  const logoH = hasLogo ? b.logoSize : 0;
  let y = L.margin + b.offsetY;
  let logo: MemeBox | null = null;
  if (hasLogo && b.logoPos === 'top') {
    logo = { x0: 0.05, y0: y, w: 0.9, h: logoH };
    y += logoH + L.gap;
  }
  const tl = memeTitleLayout(title.trim(), b.titleScale);
  const titleH = title.trim() ? tl.lines.length * tl.size * 1.18 * (MEME_W / MEME_H) : 0;
  const titleBox: MemeBox = { x0: 0.05, y0: y, w: 0.9, h: titleH };
  if (titleH) y += titleH + L.gap;
  const bottom = 1 - L.margin - (hasLogo && b.logoPos === 'bottom' ? logoH + L.gap : 0);
  if (hasLogo && b.logoPos === 'bottom') logo = { x0: 0.05, y0: 1 - L.margin - logoH, w: 0.9, h: logoH };
  // Reserva ~2 linhas de legenda embaixo do vídeo
  const maxH = Math.max(0.1, bottom - y - 0.075);
  let w = b.videoWidth;
  let h = (w * MEME_W) / aspect / MEME_H;
  if (h > maxH) {
    h = maxH;
    w = (h * MEME_H * aspect) / MEME_W;
  }
  const video: MemeBox = { x0: 0.5 - w / 2, y0: y, w, h };
  const below = y + h + 0.065;
  const captionY = below <= bottom ? below : y + h - 0.03;
  return { logo, title: { ...titleBox, ...tl }, video, captionY };
}
