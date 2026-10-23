/**
 * Ilustrações automáticas: a IA diz O QUE mostrar ("commercial airplane", "Interstellar") e este módulo
 * busca a imagem em bancos de licença livre, trata o visual (recorte com contorno ou cartão com borda)
 * e guarda em data/images/_ilustracoes. Nada aqui gasta tokens de IA.
 *
 * Fontes (só licenças que permitem uso comercial e edição):
 * - Wikimedia Commons / imagem principal da Wikipedia (sem chave): domínio público, CC0, CC BY, CC BY-SA
 * - Openverse (sem chave): CC0, domínio público, CC BY, CC BY-SA
 * - Pixabay (PIXABAY_API_KEY): licença Pixabay, sem necessidade de crédito
 * - TMDB (TMDB_API_KEY): logo/pôster de filmes e séries
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ILLUSTRATION_CATEGORY, type Illustration } from '@clipper/editing-planner';
import { dataPaths, getEnvValue, pythonScriptPath, resolvePythonBinary, runProcess } from '@clipper/shared/server';

type Log = (level: 'info' | 'warn', msg: string) => void;

export interface IllustrationImage {
  /** Caminho absoluto do PNG pronto. */
  file: string;
  fileName: string;
  source: string;
  /** Crédito exigido pela licença (null quando não precisa). */
  credit: string | null;
}

interface Candidate {
  url: string;
  source: string;
  credit: string | null;
  /** PNG/SVG costuma ter fundo transparente: vira recorte em vez de cartão. */
  transparent?: boolean;
}

interface CacheEntry {
  fileName?: string;
  source?: string;
  credit?: string | null;
  /** Busca sem resultado: não repete por alguns dias. */
  missAt?: number;
}

const UA = 'LocalVideoClipper/1.0 (ferramenta pessoal de edição; contato: usuário local)';
const MISS_TTL_MS = 7 * 24 * 3600 * 1000;
const cacheFile = () => path.join(dataPaths.root, 'cache', 'illustrations.json');
const outDir = () => path.join(dataPaths.images, ILLUSTRATION_CATEGORY);

function readCache(): Record<string, CacheEntry> {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(c: Record<string, CacheEntry>) {
  fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
  fs.writeFileSync(cacheFile(), JSON.stringify(c, null, 1));
}

let lastWikimedia = 0;

async function getJson(url: string, signal?: AbortSignal, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<any> {
  const wikimedia = /wiki(media|pedia).org/.test(url);
  for (let attempt = 0; ; attempt++) {
    // Wikimedia limita rajadas (HTTP 429): espaça as chamadas e tenta de novo uma vez
    if (wikimedia) {
      const wait = lastWikimedia + 400 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastWikimedia = Date.now();
    }
    // User-Agent próprio só para a Wikimedia (exigido lá); o Pixabay recusa (403) agentes desconhecidos
    const res = await fetch(url, { headers: { ...(wikimedia ? { 'User-Agent': UA } : {}), Accept: 'application/json', ...headers }, signal: anySignal(signal, timeoutMs) });
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} de ${new URL(url).host}`);
    return res.json();
  }
}

function anySignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

const stripHtml = (s?: string) => (s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

/** Licenças aceitas: livres para uso comercial e para modificar (sem NC/ND). */
function freeLicense(name: string): boolean {
  const n = name.toLowerCase();
  if (/\b(nc|nd)\b|non-?commercial|no-?deriv|fair use|non-free/.test(n)) return false;
  return /public domain|^pd|cc0|cc[- ]by|attribution|pdm/.test(n);
}
const needsCredit = (license: string) => !/public domain|^pd|cc0|pdm/i.test(license);

// ---------------- Fontes ----------------

/** Arquivos da Commons com licença livre; `titles` = "File:..." ou busca textual. */
async function commonsInfo(params: Record<string, string>, signal?: AbortSignal): Promise<Candidate[]> {
  const qs = new URLSearchParams({ action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', iiurlwidth: '900', origin: '*', ...params });
  const json = await getJson(`https://commons.wikimedia.org/w/api.php?${qs}`, signal);
  const pages = Object.values(json?.query?.pages ?? {}) as any[];
  pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: Candidate[] = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii || !/image\/(png|jpeg|svg\+xml|webp)/.test(ii.mime ?? '')) continue;
    if ((ii.width ?? 0) < 300 && !/svg/.test(ii.mime)) continue;
    const meta = ii.extmetadata ?? {};
    const license = stripHtml(meta.LicenseShortName?.value) || stripHtml(meta.License?.value);
    if (!freeLicense(license)) continue;
    const author = stripHtml(meta.Artist?.value) || 'autor desconhecido';
    out.push({
      url: ii.thumburl ?? ii.url,
      source: 'Wikimedia Commons',
      credit: needsCredit(license) ? `${author}, ${license} (Wikimedia Commons)` : null,
      transparent: /png|svg/.test(ii.mime),
    });
  }
  return out;
}

/** Imagem principal do artigo da Wikipedia com esse título — só se estiver na Commons com licença livre. */
async function wikipediaLead(query: string, signal?: AbortSignal): Promise<Candidate[]> {
  for (const lang of ['en', 'pt']) {
    const qs = new URLSearchParams({ action: 'query', format: 'json', titles: query, redirects: '1', prop: 'pageimages', piprop: 'name', origin: '*' });
    const json = await getJson(`https://${lang}.wikipedia.org/w/api.php?${qs}`, signal);
    const page = Object.values(json?.query?.pages ?? {})[0] as any;
    // Arquivos "non-free" (logos, pôsteres) ficam só na Wikipedia local: a consulta na Commons não os encontra
    if (page?.pageimage) {
      const found = await commonsInfo({ titles: `File:${page.pageimage}` }, signal);
      if (found.length) return found;
    }
  }
  return [];
}

/** Busca na Commons exigindo as palavras no NOME do arquivo (a busca no texto traz muita coisa sem relação). */
const commonsSearch = (query: string, signal?: AbortSignal) =>
  commonsInfo({ generator: 'search', gsrsearch: query.split(/s+/).filter(Boolean).map((w) => `intitle:${w}`).join(' '), gsrnamespace: '6', gsrlimit: '8' }, signal);

async function openverse(query: string, signal?: AbortSignal): Promise<Candidate[]> {
  const qs = new URLSearchParams({ q: query, license_type: 'commercial,modification', page_size: '10', mature: 'false' });
  const json = await getJson(`https://api.openverse.org/v1/images/?${qs}`, signal, {}, 8_000);
  return ((json?.results ?? []) as any[])
    .filter((r) => (r.width ?? 1000) >= 300 && freeLicense(`${r.license === 'pdm' ? 'pdm' : r.license === 'cc0' ? 'cc0' : `cc-${r.license}`}`))
    .map((r) => {
      const license = r.license === 'pdm' ? 'Public Domain' : r.license === 'cc0' ? 'CC0' : `CC ${String(r.license).toUpperCase()} ${r.license_version ?? ''}`.trim();
      return {
        url: r.url,
        source: `Openverse (${r.provider ?? r.source ?? 'CC'})`,
        credit: needsCredit(license) ? `${stripHtml(r.creator) || 'autor desconhecido'}, ${license} (via Openverse)` : null,
        transparent: /png|svg/i.test(r.filetype ?? ''),
      };
    });
}

async function pixabay(query: string, kind: Illustration['kind'], signal?: AbortSignal): Promise<Candidate[]> {
  const key = getEnvValue('PIXABAY_API_KEY');
  if (!key) return [];
  const fetchType = async (imageType: string) => {
    const qs = new URLSearchParams({ key, q: query.slice(0, 100), image_type: imageType, safesearch: 'true', per_page: '10', lang: 'en', order: 'popular' });
    const json = await getJson(`https://pixabay.com/api/?${qs}`, signal);
    return ((json?.hits ?? []) as any[]).map((h) => ({
      url: h.largeImageURL ?? h.webformatURL,
      source: 'Pixabay',
      credit: null,
      transparent: /\.png$/i.test(h.largeImageURL ?? '') || h.type === 'vector/svg',
    }));
  };
  // Foto primeiro: a ilustração "mais popular" nem sempre é o objeto certo ("airplane" trazia avião de papel)
  return fetchType('photo');
}

async function tmdb(query: string, kind: Illustration['kind'], signal?: AbortSignal): Promise<Candidate[]> {
  const key = getEnvValue('TMDB_API_KEY');
  if (!key) return [];
  // Aceita a "API Key" (v3) ou o "Read Access Token" (v4, bem mais longo)
  const bearer = key.length > 40;
  const auth: Record<string, string> = bearer ? { Authorization: `Bearer ${key}` } : {};
  const withKey = (u: string) => (bearer ? u : `${u}${u.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`);
  const type = kind === 'series' ? 'tv' : 'movie';
  const search = await getJson(withKey(`https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(query)}&include_adult=false`), signal, auth);
  const hit = (search?.results ?? [])[0];
  if (!hit) return [];
  const imgs = await getJson(withKey(`https://api.themoviedb.org/3/${type}/${hit.id}/images?include_image_language=en,pt,null`), signal, auth);
  const pick = (arr: any[]) => [...(arr ?? [])].sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))[0];
  const out: Candidate[] = [];
  const logo = pick(imgs?.logos);
  if (logo?.file_path && /\.png$/i.test(logo.file_path)) out.push({ url: `https://image.tmdb.org/t/p/w500${logo.file_path}`, source: 'TMDB', credit: null, transparent: true });
  const poster = pick(imgs?.posters) ?? (hit.poster_path ? { file_path: hit.poster_path } : null);
  if (poster?.file_path) out.push({ url: `https://image.tmdb.org/t/p/w500${poster.file_path}`, source: 'TMDB', credit: null });
  return out;
}

/** Ordem das fontes por tipo de coisa: cada uma é boa num assunto. */
function plan(il: Illustration): ((signal?: AbortSignal) => Promise<Candidate[]>)[] {
  const q = il.query;
  switch (il.kind) {
    // Filme/série: pôster e logo só no TMDB (na Wikipedia são "non-free"); busca genérica traria coisa errada
    case 'movie':
    case 'series':
      return [(s) => tmdb(q, il.kind, s), (s) => wikipediaLead(q, s)];
    // Jogo: capa é "non-free"; buscas genéricas trazem fotos sem relação (gente de camiseta do jogo)
    case 'game':
      return [(s) => wikipediaLead(q, s)];
    case 'person':
    case 'brand':
    case 'place':
      return [(s) => wikipediaLead(q, s), (s) => commonsSearch(q, s)];
    default:
      return [(s) => pixabay(q, il.kind, s), (s) => wikipediaLead(q, s), (s) => openverse(q, s), (s) => commonsSearch(q, s)];
  }
}

// ---------------- Download e tratamento ----------------

async function download(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { headers: /wiki(media|pedia).org/.test(url) ? { 'User-Agent': UA } : {}, signal: anySignal(signal, 30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/^image\/(png|jpeg|webp)/.test(type)) throw new Error(`tipo ${type || 'desconhecido'}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 25 * 1024 * 1024) throw new Error('imagem grande demais');
  fs.writeFileSync(dest, buf);
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40) || 'imagem';

/**
 * Busca (ou reaproveita do cache) a imagem de uma ilustração. Retorna null se nenhuma fonte tiver
 * uma imagem com licença livre — nesse caso o corte simplesmente fica sem essa ilustração.
 */
export async function getIllustration(il: Illustration, opts: { log: Log; signal?: AbortSignal; workDir: string }): Promise<IllustrationImage | null> {
  const key = `${il.kind}:${il.query.trim().toLowerCase()}`;
  const cache = readCache();
  const hit = cache[key];
  if (hit?.fileName && fs.existsSync(path.join(outDir(), hit.fileName))) {
    return { file: path.join(outDir(), hit.fileName), fileName: hit.fileName, source: hit.source ?? '', credit: hit.credit ?? null };
  }
  if (hit?.missAt && Date.now() - hit.missAt < MISS_TTL_MS) return null;

  fs.mkdirSync(outDir(), { recursive: true });
  fs.mkdirSync(opts.workDir, { recursive: true });
  const tries: string[] = [];
  for (const source of plan(il)) {
    let candidates: Candidate[] = [];
    try {
      candidates = await source(opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      tries.push((e as Error).message);
      continue;
    }
    for (const c of candidates.slice(0, 3)) {
      const raw = path.join(opts.workDir, `ilus_${createHash('sha1').update(c.url).digest('hex').slice(0, 12)}`);
      const fileName = `${slug(il.query)}_${createHash('sha1').update(key).digest('hex').slice(0, 6)}.png`;
      try {
        await download(c.url, raw, opts.signal);
        const r = await runProcess(resolvePythonBinary(), [pythonScriptPath('prepare_illustration.py'), raw, path.join(outDir(), fileName), '720'], {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          signal: opts.signal,
          timeoutMs: 60_000,
        });
        if (r.code !== 0 || !fs.existsSync(path.join(outDir(), fileName))) throw new Error(`tratamento falhou: ${r.stderrTail.trim().split('\n').pop() ?? ''}`);
        const style = /"style":\s*"(\w+)"/.exec(r.stdout)?.[1] ?? '';
        cache[key] = { fileName, source: c.source, credit: c.credit };
        writeCache(cache);
        opts.log('info', `Ilustração "${il.label || il.query}": ${c.source}${style === 'cutout' ? ' (recorte)' : style === 'card' ? ' (cartão)' : ''}`);
        return { file: path.join(outDir(), fileName), fileName, source: c.source, credit: c.credit };
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        tries.push(`${c.source}: ${(e as Error).message}`);
      } finally {
        fs.rmSync(raw, { force: true });
      }
    }
  }
  cache[key] = { missAt: Date.now() };
  writeCache(cache);
  opts.log('warn', `Ilustração "${il.label || il.query}": nenhuma imagem livre encontrada${tries.length ? ` (${tries.slice(0, 3).join('; ')})` : ''}`);
  return null;
}
