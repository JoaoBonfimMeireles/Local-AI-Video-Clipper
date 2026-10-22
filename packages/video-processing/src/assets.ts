import fs from 'node:fs';
import path from 'node:path';
import { resolveBinary, runProcess } from '@clipper/shared/server';
import { sec } from './ffmpeg';
import { probeAsset } from './probe';

export interface AssetInfo {
  duration: number;
  hasAudio: boolean;
  /** Vídeo/imagem com fundo verde (ex.: Green Screen Memes): recebe chroma key no render. */
  greenScreen: boolean;
  /** Cor de fundo detectada (hex 0xRRGGBB) para o chroma key. */
  keyColor: string | null;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);

/**
 * Amostra 3 frames em baixa resolução e mede quanto da imagem (principalmente as bordas) é verde
 * saturado. Fundo verde de meme cobre a maior parte das bordas.
 */
async function detectGreen(file: string, duration: number): Promise<{ green: boolean; color: string | null }> {
  const times = duration > 0.5 ? [duration * 0.2, duration * 0.5, duration * 0.8] : [0];
  let edgeGreen = 0;
  let edgeTotal = 0;
  let sum = [0, 0, 0];
  let n = 0;
  for (const t of times) {
    const res = await runProcess(
      resolveBinary('ffmpeg'),
      ['-hide_banner', '-loglevel', 'error', ...(duration > 0.5 ? ['-ss', sec(t)] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=48:27,format=rgb24', '-f', 'rawvideo', 'pipe:1'],
      { timeoutMs: 30_000, binaryStdout: true },
    ).catch(() => null);
    if (!res || res.code !== 0) continue;
    const buf = Buffer.from(res.stdout, 'latin1');
    const W = 48;
    const H = 27;
    if (buf.length < W * H * 3) continue;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const edge = x < 4 || x >= W - 4 || y < 3 || y >= H - 3;
        if (!edge) continue;
        const i = (y * W + x) * 3;
        const r = buf[i];
        const g = buf[i + 1];
        const b = buf[i + 2];
        edgeTotal++;
        if (g > 90 && g > r * 1.35 && g > b * 1.35) {
          edgeGreen++;
          sum = [sum[0] + r, sum[1] + g, sum[2] + b];
          n++;
        }
      }
    }
  }
  const green = edgeTotal > 0 && edgeGreen / edgeTotal > 0.45;
  const hex = (v: number) => Math.round(v / Math.max(1, n)).toString(16).padStart(2, '0');
  return { green, color: green ? `0x${hex(sum[0])}${hex(sum[1])}${hex(sum[2])}` : null };
}

export async function analyzeAsset(file: string): Promise<AssetInfo> {
  const ext = path.extname(file).toLowerCase();
  const p = await probeAsset(file);
  // Som: só a duração importa (sem análise de imagem)
  if (['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(ext)) return { duration: p.duration, hasAudio: true, greenScreen: false, keyColor: null };
  const isStill = IMAGE_EXT.has(ext) && ext !== '.gif';
  const duration = isStill ? 0 : p.duration;
  const g = await detectGreen(file, duration);
  return { duration, hasAudio: p.hasAudio, greenScreen: g.green, keyColor: g.color };
}

/** Analisa (com cache por caminho+tamanho+data) uma lista de assets. */
export async function analyzeAssets(files: string[], cacheFile: string): Promise<Map<string, AssetInfo>> {
  let cache: Record<string, AssetInfo & { key: string }> = {};
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    /* sem cache ainda */
  }
  const out = new Map<string, AssetInfo>();
  let changed = false;
  for (const f of files) {
    const st = fs.statSync(f);
    const key = `${st.size}:${Math.floor(st.mtimeMs)}`;
    const hit = cache[f];
    if (hit && hit.key === key) {
      out.set(f, hit);
      continue;
    }
    const info = await analyzeAsset(f);
    cache[f] = { ...info, key };
    out.set(f, info);
    changed = true;
  }
  if (changed) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return out;
}
