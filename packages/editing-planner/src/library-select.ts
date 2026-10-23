import type { LibraryIndex } from '@clipper/shared';

/** Palavras que só descrevem o formato do arquivo, não o meme. */
const NOISE = new Set([
  'meme', 'memes', 'green', 'screen', 'greenscreen', 'template', 'small', 'video', 'hd', 'full', 'mp4', 'mov', 'webm', 'gif',
  'png', 'jpg', 'sound', 'sounds', 'effect', 'sfx', 'audio', 'mp3', 'wav', 'free', 'download', 'original', 'version',
  'шаблон', 'мем', 'хромакей', 'хромакее', 'футаж', 'the', 'and', 'with', 'for', 'com', 'para', 'efeito', 'som',
]);

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Decodifica %XX tolerando nomes cortados no meio de um caractere (comum em downloads com nome longo):
 * bytes inválidos no fim são descartados em vez de invalidar o nome inteiro.
 */
function decodeLoose(name: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    const m = name[i] === '%' ? /^[0-9a-f]{2}/i.exec(name.slice(i + 1, i + 3)) : null;
    if (m) {
      bytes.push(parseInt(m[0], 16));
      i += 2;
    } else if (name[i] === '%') {
      continue; // "%" solto no fim (nome truncado)
    } else {
      bytes.push(...new TextEncoder().encode(name[i]));
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes)).replace(/�/g, '');
}

/** "Ai-cat-laughing-Meme-Green-Screen.mp4" → "Ai cat laughing". Decodifica nomes em %XX (ex.: cirílico). */
export function prettyAssetName(file: string): string {
  let name = file.replace(/\.[a-z0-9]{2,4}$/i, '');
  if (/%[0-9a-f]{2}/i.test(name)) name = decodeLoose(name);
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s\-_.+()[\]{},]+/)
    .filter((w) => w && !NOISE.has(strip(w)) && !/^\d+$/.test(w) && !/^\d+p$/i.test(w));
  return words.join(' ').trim();
}

export function nameTokens(file: string): string[] {
  return strip(prettyAssetName(file))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
}

/** Conceitos de reação em PT (como aparecem na fala/análise) → palavras comuns em nomes de memes/sons (EN). */
const EXPAND: [RegExp, string[]][] = [
  [/^(kkk+|haha+|risad|rindo|engracad|piada|zoeir|zoand|comedia)/, ['laugh', 'laughing', 'funny', 'lol', 'haha', 'joke', 'clown']],
  [/^(sust|assust|medo|terror|grit|jumpscare|tens)/, ['scared', 'scream', 'horror', 'shock', 'fear', 'scary', 'jumpscare']],
  [/^(surpres|choc|chocad|uau|nossa|caramba|serio|mentira|absurd)/, ['shocked', 'surprised', 'wow', 'omg', 'what', 'shock', 'amazed']],
  [/^(trist|chor|deprim|sad)/, ['sad', 'cry', 'crying', 'violin', 'tears']],
  [/^(raiva|brav|irrit|odio|pistol)/, ['angry', 'mad', 'rage', 'annoyed', 'furious']],
  [/^(danc|festa|comemor|celebr)/, ['dance', 'dancing', 'party', 'celebration']],
  [/^(ganh|vitori|venc|consegu|clutch|lend)/, ['win', 'winner', 'victory', 'champion', 'legend', 'sigma', 'cool']],
  [/^(perd|errou|erro|falh|fail|morr|derrot)/, ['fail', 'bruh', 'sad', 'lose', 'oops', 'wasted', 'dead']],
  [/^(dinheir|rico|grana|pix|donat|doa)/, ['money', 'rich', 'cash', 'dollar']],
  [/^(comid|comer|fome|gostos|delici)/, ['food', 'eating', 'eat', 'hungry', 'delicious', 'yummy']],
  [/^(olh|encar|julg|descon)/, ['side', 'eye', 'stare', 'look', 'suspicious', 'judging']],
  [/^(confus|entend|duvid|hein)/, ['confused', 'thinking', 'what', 'huh', 'math']],
  [/^(nojo|eca|credo)/, ['disgust', 'disgusted', 'eww']],
  [/^(corr|fug|fuga)/, ['running', 'run', 'escape']],
  [/^(gato|gatinh)/, ['cat', 'kitten']],
  [/^(cachorr|dog)/, ['dog', 'puppy']],
  [/^(silenci|vergonh|constrang|cringe)/, ['awkward', 'cringe', 'silence', 'crickets', 'shame']],
  [/^(bat|explo|bomb)/, ['boom', 'explosion', 'impact', 'hit']],
  [/^(chat|viewer|inscrit)/, ['chat', 'reaction', 'react']],
];

/** Sempre úteis como reserva quando nada combina diretamente. */
const GENERIC = ['laugh', 'laughing', 'shocked', 'wow', 'omg', 'what', 'bruh', 'boom', 'side', 'sad', 'fail', 'whoosh', 'vine', 'dramatic', 'clap'];

function contextTokens(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const w of strip(t).split(/[^\p{L}\p{N}]+/u)) {
      if (w.length < 3) continue;
      out.add(w);
      for (const [re, add] of EXPAND) if (re.test(w)) add.forEach((a) => out.add(a));
    }
  }
  return out;
}

function seeded(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 13), 1274126177)), ((h >>> 0) % 10000) / 10000);
}

/**
 * Pré-seleção da biblioteca para uma chamada de IA: os arquivos cujo NOME combina com o contexto dos
 * cortes (fala, análise, categorias), mais alguns genéricos de reação e uma amostra variada.
 * Mantém a estrutura de categorias (pasta única aparece como "_geral").
 */
/** Pasta (em data/images) das imagens que o app busca sozinho para ilustrar a fala. */
export const ILLUSTRATION_CATEGORY = '_ilustracoes';

export function shortlistLibrary(lib: LibraryIndex, texts: string[], limits = { memes: 70, images: 20, audio: 50 }, seed = 'x'): LibraryIndex {
  // Ilustrações baixadas automaticamente não são memes: ficam fora do catálogo oferecido à IA
  lib = { ...lib, images: lib.images.filter((c) => c.name !== ILLUSTRATION_CATEGORY) };
  const ctx = contextTokens(texts);
  const rnd = seeded(seed);
  const pickKind = (kind: keyof LibraryIndex, max: number) => {
    const all = lib[kind].flatMap((c) => c.files.map((file) => ({ cat: c.name, file, tokens: nameTokens(file) })));
    if (all.length <= max) return lib[kind];
    const scored = all.map((a) => {
      const hits = a.tokens.filter((t) => ctx.has(t)).length;
      const generic = a.tokens.some((t) => GENERIC.includes(t)) ? 0.5 : 0;
      return { ...a, score: hits * 2 + generic + (a.tokens.length ? 0 : -5) };
    });
    const relevant = scored.filter((a) => a.score >= 2).sort((a, b) => b.score - a.score).slice(0, Math.ceil(max * 0.65));
    const chosen = new Set(relevant.map((a) => `${a.cat}/${a.file}`));
    const generic = scored.filter((a) => a.score > 0 && !chosen.has(`${a.cat}/${a.file}`)).sort((a, b) => b.score - a.score);
    for (const g of generic) {
      if (chosen.size >= Math.ceil(max * 0.85)) break;
      chosen.add(`${g.cat}/${g.file}`);
    }
    // Amostra variada (determinística) para a IA ter opções fora do óbvio
    const rest = scored.filter((a) => !chosen.has(`${a.cat}/${a.file}`) && a.tokens.length);
    while (chosen.size < max && rest.length) chosen.add((({ cat, file }) => `${cat}/${file}`)(rest.splice(Math.floor(rnd() * rest.length), 1)[0]));
    return lib[kind].map((c) => ({ name: c.name, files: c.files.filter((f) => chosen.has(`${c.name}/${f}`)) })).filter((c) => c.files.length);
  };
  return { memes: pickKind('memes', limits.memes), images: pickKind('images', limits.images), audio: pickKind('audio', limits.audio) };
}

/** Melhor arquivo pelo nome (para quando a IA erra a grafia ou a heurística busca por palavra-chave). */
export function matchAssetByName(lib: LibraryIndex, kind: keyof LibraryIndex, query: string[] | string): { category: string; file: string; score: number } | null {
  const q = new Set(Array.isArray(query) ? query.map(strip) : nameTokens(query));
  if (!q.size) return null;
  let best: { category: string; file: string; score: number } | null = null;
  for (const c of lib[kind]) {
    for (const f of c.files) {
      const t = nameTokens(f);
      if (!t.length) continue;
      const hits = t.filter((x) => q.has(x)).length;
      const score = hits / Math.max(q.size, Math.min(t.length, 4));
      if (hits && (!best || score > best.score)) best = { category: c.name, file: f, score };
    }
  }
  return best;
}

export interface CatalogEntry {
  kind: keyof LibraryIndex;
  category: string;
  file: string;
}

/**
 * Catálogo compacto para o prompt: cada arquivo vira um código curto (m1, i1, s1) com o nome legível e
 * metadados. A IA responde com o código; o app converte para o arquivo real (sem erros de grafia).
 */
export function buildCatalog(lib: LibraryIndex, meta?: Record<string, { duration: number; hasAudio: boolean; greenScreen: boolean }>): { text: string; byId: Map<string, CatalogEntry> } {
  const byId = new Map<string, CatalogEntry>();
  const sections: string[] = [];
  const prefix: Record<keyof LibraryIndex, string> = { memes: 'm', images: 'i', audio: 's' };
  const title: Record<keyof LibraryIndex, string> = { memes: 'MEMES (vídeo/gif/imagem, type "meme")', images: 'IMAGENS (type "image")', audio: 'SONS (sfx)' };
  for (const kind of ['memes', 'images', 'audio'] as const) {
    const lines: string[] = [];
    let n = 0;
    for (const c of lib[kind]) {
      for (const f of c.files) {
        const id = `${prefix[kind]}${++n}`;
        byId.set(id, { kind, category: c.name, file: f });
        const m = meta?.[`${kind}/${c.name}/${f}`];
        const tags = m ? [m.duration ? `${m.duration.toFixed(1)}s` : '', kind === 'memes' ? (m.hasAudio ? 'com áudio' : 'mudo') : '', m.greenScreen ? 'fundo verde' : ''].filter(Boolean).join(', ') : '';
        const cat = c.name !== '_geral' ? ` [${c.name}]` : '';
        lines.push(`  ${id}: ${prettyAssetName(f) || f}${cat}${tags ? ` (${tags})` : ''}`);
      }
    }
    if (lines.length) sections.push(`${title[kind]}:\n${lines.join('\n')}`);
  }
  return { text: sections.join('\n'), byId };
}

/** Todos os arquivos cujo nome contém alguma das palavras-chave, do mais relevante ao menos. */
export function findAssetsByKeywords(lib: LibraryIndex, kind: keyof LibraryIndex, keywords: string[]): { category: string; file: string; score: number }[] {
  const q = new Set(keywords.map(strip));
  const out: { category: string; file: string; score: number }[] = [];
  for (const c of lib[kind]) {
    for (const f of c.files) {
      const t = nameTokens(f);
      const hits = t.filter((x) => q.has(x)).length + (q.has(strip(c.name)) ? 0.5 : 0);
      if (hits > 0) out.push({ category: c.name, file: f, score: hits / Math.max(1, Math.min(t.length, 5)) });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
