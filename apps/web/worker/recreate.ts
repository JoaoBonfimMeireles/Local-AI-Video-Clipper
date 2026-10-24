// Sessão "a partir de um corte viral": prepara o corte de referência (transcrição + frames), descobre de onde ele saiu
// no vídeo original comparando as falas, define quanto do original a IA lê (limite de tokens) e aplica o material
// (imagens/memes/sons) que o editor mandou para os pedidos da IA.
import fs from 'node:fs';
import path from 'node:path';
import { transcribe } from '@clipper/ai-providers';
import type { ResolvedEdit } from '@clipper/editing-planner';
import type { AppSettings, AssetRequest, JobSettings, Transcript } from '@clipper/shared';
import { dataPaths, safeJoin } from '@clipper/shared/server';
import { extractAudio, extractFrames, probe, probeAsset } from '@clipper/video-processing';
import { transcriptCachePath } from './pipeline';

type Log = (level: 'info' | 'warn', msg: string) => void;

export interface MatchedPart {
  /** Trecho no original. */
  start: number;
  end: number;
  /** Onde ele aparece no corte de referência. */
  refStart: number;
  refEnd: number;
}

export interface PreparedReference {
  transcript: Transcript;
  frames: { time: number; path: string }[];
  matched: MatchedPart[];
  /** Parte do original que a IA lê e onde procura cortes. */
  window: { start: number; end: number };
}

const norm = (w: string) =>
  w
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Acha os trechos do original que o corte usa: trincas de palavras iguais nos dois, agrupadas pelo deslocamento
 * de tempo (cada trecho do corte tem um deslocamento constante em relação ao original; trechos reordenados têm outro).
 */
export function alignReference(ref: Transcript, original: Transcript): MatchedPart[] {
  const words = (t: Transcript) => t.segments.flatMap((s) => s.words).map((w) => ({ ...w, k: norm(w.word) })).filter((w) => w.k);
  const rw = words(ref);
  const ow = words(original);
  if (rw.length < 3 || ow.length < 3) return [];
  const N = 3;
  const index = new Map<string, number[]>();
  for (let i = 0; i + N <= ow.length; i++) {
    const key = ow.slice(i, i + N).map((w) => w.k).join(' ');
    const list = index.get(key);
    if (list) list.length < 30 && list.push(i);
    else index.set(key, [i]);
  }
  const pairs: { r: number; o: number; rEnd: number; oEnd: number; off: number }[] = [];
  for (let i = 0; i + N <= rw.length; i++) {
    const hits = index.get(rw.slice(i, i + N).map((w) => w.k).join(' ')) ?? [];
    for (const j of hits) pairs.push({ r: rw[i].start, o: ow[j].start, rEnd: rw[i + N - 1].end, oEnd: ow[j + N - 1].end, off: ow[j].start - rw[i].start });
  }
  // Deslocamentos em faixas de 3s; só faixas com bastante coincidência contam (frases comuns se repetem por acaso)
  const buckets = new Map<number, typeof pairs>();
  for (const p of pairs) {
    const b = Math.round(p.off / 3);
    buckets.set(b, [...(buckets.get(b) ?? []), p]);
  }
  const minHits = Math.max(4, Math.round(rw.length * 0.06));
  const parts: MatchedPart[] = [];
  const used = new Set<number>();
  for (const [b, list] of [...buckets.entries()].sort((x, y) => y[1].length - x[1].length)) {
    // Faixa vizinha (o deslocamento caiu na fronteira) junta com a principal
    if (used.has(b)) continue;
    const merged = [...list, ...(buckets.get(b - 1) ?? []), ...(buckets.get(b + 1) ?? [])].filter((p) => !used.has(Math.round(p.off / 3)) || Math.round(p.off / 3) === b);
    used.add(b).add(b - 1).add(b + 1);
    if (merged.length < minHits) continue;
    // Dentro da faixa, um buraco de mais de 8s no corte separa dois trechos
    const sorted = merged.sort((x, y) => x.r - y.r);
    let cur = { start: sorted[0].o, end: sorted[0].oEnd, refStart: sorted[0].r, refEnd: sorted[0].rEnd, n: 1 };
    const flush = () => cur.n >= Math.min(minHits, 3) && parts.push({ start: cur.start, end: cur.end, refStart: cur.refStart, refEnd: cur.refEnd });
    for (const p of sorted.slice(1)) {
      if (p.r - cur.refEnd > 8) {
        flush();
        cur = { start: p.o, end: p.oEnd, refStart: p.r, refEnd: p.rEnd, n: 1 };
      } else {
        cur = { start: Math.min(cur.start, p.o), end: Math.max(cur.end, p.oEnd), refStart: Math.min(cur.refStart, p.r), refEnd: Math.max(cur.refEnd, p.rEnd), n: cur.n + 1 };
      }
    }
    flush();
  }
  return parts.sort((a, b) => a.refStart - b.refStart);
}

/** Quanto do original a IA lê: o trecho escolhido no painel, ou `scanMinutes` em volta do trecho do corte. */
export function referenceWindow(matched: MatchedPart[], duration: number, scanMinutes: number | null, range: { start: number; end: number } | null): { start: number; end: number } {
  if (range) return range;
  if (scanMinutes === null) return { start: 0, end: duration };
  const a = matched.length ? Math.min(...matched.map((m) => m.start)) : 0;
  const b = matched.length ? Math.max(...matched.map((m) => m.end)) : Math.min(duration, scanMinutes * 60 || 120);
  // 0 = só o trecho do corte, com 45s de contexto de cada lado
  const want = Math.max(b - a + 90, scanMinutes * 60);
  const pad = (want - (b - a)) / 2;
  let start = Math.max(0, a - pad);
  const end = Math.min(duration, start + want);
  start = Math.max(0, end - want);
  return { start, end };
}

export async function prepareReference(args: {
  ref: NonNullable<JobSettings['reference']>;
  original: Transcript;
  duration: number;
  range: { start: number; end: number } | null;
  app: AppSettings;
  language: string;
  tempDir: string;
  signal: AbortSignal;
  log: Log;
}): Promise<PreparedReference> {
  const file = safeJoin(dataPaths.input, path.basename(args.ref.clipFile));
  if (!fs.existsSync(file)) throw new Error(`Corte de referência não encontrado: ${args.ref.clipFile}`);
  const info = await probe(file, args.signal);
  const dir = path.join(args.tempDir, 'reference');
  fs.mkdirSync(dir, { recursive: true });
  // Transcrição do corte (cache global, igual ao do vídeo original)
  const cache = transcriptCachePath(file, args.app.whisperModel, args.language);
  let transcript: Transcript;
  if (fs.existsSync(cache)) transcript = JSON.parse(fs.readFileSync(cache, 'utf8')) as Transcript;
  else {
    const wav = path.join(dir, 'audio.wav');
    if (!fs.existsSync(wav)) await extractAudio(file, wav, { signal: args.signal, duration: info.duration });
    transcript = await transcribe({ audioPath: wav, outputJson: path.join(dir, 'whisper-raw.json'), model: args.app.whisperModel, device: args.app.whisperDevice, language: args.language, threads: args.app.threads, signal: args.signal });
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(transcript));
  }
  args.log('info', `Corte de referência: ${path.basename(file)} (${info.duration.toFixed(0)}s, ${transcript.segments.length} falas)`);
  // 10 frames espalhados: mostram à IA o que o corte põe na tela (enquadramento, textos, imagens)
  const times = Array.from({ length: 10 }, (_, i) => ({ time: Math.min(info.duration - 0.2, ((i + 0.5) * info.duration) / 10), reason: 'corte de referência' }));
  const framesFile = path.join(dir, 'frames.json');
  const frames = fs.existsSync(framesFile)
    ? (JSON.parse(fs.readFileSync(framesFile, 'utf8')) as { time: number; path: string }[])
    : (await extractFrames(file, times, path.join(dir, 'frames'), { signal: args.signal })).map((f) => ({ time: f.time, path: f.path }));
  fs.writeFileSync(framesFile, JSON.stringify(frames));
  const matched = alignReference(transcript, args.original);
  if (matched.length) {
    args.log('info', `Corte localizado no original: ${matched.map((m) => `${m.start.toFixed(0)}–${m.end.toFixed(0)}s`).join(' + ')}${matched.length > 1 ? ' (montado com trechos em outra ordem)' : ''}`);
  } else {
    args.log('warn', 'Não foi possível localizar o corte no original pelas falas; a IA vai procurar pelo conteúdo');
  }
  const window = referenceWindow(matched, args.duration, args.ref.scanMinutes, args.range);
  args.log('info', `A IA lê ${Math.round((window.end - window.start) / 60)} min do original (${window.start.toFixed(0)}–${window.end.toFixed(0)}s)${args.ref.scanMinutes === null && !args.range ? ' — vídeo inteiro' : ' — limite para economizar tokens'}`);
  return { transcript, frames, matched, window };
}

/** Pasta onde o editor manda o material pedido (um arquivo por pedido: <id>.<ext>). */
export const requestsDir = (outputDir: string) => path.join(outputDir, 'pedidos');
export const requestsFile = (outputDir: string) => path.join(outputDir, 'pedidos.json');

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|gif)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac)$/i;

/** Arquivo que o editor mandou para um pedido (o mais recente, se houver mais de um). */
export function uploadedFor(outputDir: string, id: string): string | null {
  const dir = requestsDir(outputDir);
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((n) => path.parse(n).name === id).sort().pop();
  return f ? path.join(dir, f) : null;
}

/** Guarda os pedidos de todos os cortes (a tela de pedidos lê este arquivo). */
export function writeRequests(outputDir: string, clips: { index: number; title: string; variant?: string | null; assetRequests?: AssetRequest[] }[], concept: string) {
  const data = {
    concept,
    clips: clips.map((c) => ({ index: c.index, title: c.title, variant: c.variant ?? null, requests: c.assetRequests ?? [] })),
  };
  fs.writeFileSync(requestsFile(outputDir), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Coloca no plano o material que já chegou: imagem/meme como sobreposição (tela inteira, canto ou topo) e som como
 * efeito com o vídeo pausado. Pedidos sem arquivo ficam de fora (nada de meme aleatório no lugar).
 */
export async function applyUploadedAssets(plan: ResolvedEdit[], clips: { index: number; assetRequests?: AssetRequest[] }[], outputDir: string, log: Log): Promise<void> {
  for (const c of clips) {
    const p = plan.find((x) => x.clipIndex === c.index);
    if (!p) continue;
    let used = 0;
    for (const r of c.assetRequests ?? []) {
      const file = uploadedFor(outputDir, r.id);
      if (!file) continue;
      // Já aplicado num processamento anterior (plano em cache)
      if (p.overlays.some((o) => o.file === file) || p.sfx.some((x) => x.file === file)) continue;
      const fileName = path.basename(file);
      if (AUDIO_EXT.test(file) || (r.kind === 'sound' && !IMAGE_EXT.test(file))) {
        const inf = await probeAsset(file).catch(() => null);
        p.sfx.push({ category: '_pedidos', file, fileName, at: r.at, volume: 0.8, duration: Math.min(r.duration, inf?.duration || r.duration) });
      } else if (IMAGE_EXT.test(file) || VIDEO_EXT.test(file)) {
        const full = r.display === 'full';
        p.overlays.push({
          type: VIDEO_EXT.test(file) ? 'meme' : 'image',
          category: '_pedidos',
          file,
          fileName,
          at: r.at,
          duration: r.duration,
          position: full ? 'center' : r.display === 'top' ? 'top' : 'top-right',
          scale: full ? 1 : 0.42,
          audioMode: 'video',
          reason: `pedido: ${r.what}`,
        });
      } else continue;
      used++;
    }
    p.overlays.sort((a, b) => a.at - b.at);
    p.sfx.sort((a, b) => a.at - b.at);
    if (used) log('info', `Corte ${c.index + 1}: ${used} material(is) enviado(s) aplicado(s)`);
  }
}
