import { resolveBinary, runProcess } from '@clipper/shared/server';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const W = 160;
const H = 90;

async function grayFrame(file: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  const res = await runProcess(resolveBinary('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', 'pipe:1'], {
    timeoutMs: 20_000,
    binaryStdout: true,
    signal,
  }).catch(() => null);
  if (!res || res.code !== 0) return null;
  const buf = Buffer.from(res.stdout, 'latin1');
  return buf.length >= W * H ? new Uint8Array(buf.subarray(0, W * H)) : null;
}

/** Maior sequência de índices "ativos", tolerando pequenas falhas (gap). */
function longestRun(active: boolean[], gap: number): [number, number] | null {
  let best: [number, number] | null = null;
  let start = -1;
  let last = -1;
  for (let i = 0; i <= active.length; i++) {
    if (i < active.length && active[i]) {
      if (start < 0) start = i;
      last = i;
    } else if (start >= 0 && (i === active.length || i - last > gap)) {
      if (!best || last - start > best[1] - best[0]) best = [start, last];
      start = -1;
    }
  }
  return best;
}

/**
 * Área do quadro onde o CONTEÚDO se mexe (ex.: o vídeo que o streamer está assistindo num react),
 * ignorando a facecam e molduras/fundos estáticos. Usa a variação de cada pixel ao longo dos frames.
 * Retorna frações do quadro, ou null se o movimento ocupa praticamente a tela toda (nada a recortar).
 */
export async function detectContentRegion(framePaths: string[], exclude: Box | null, signal?: AbortSignal): Promise<Box | null> {
  const step = Math.max(1, Math.floor(framePaths.length / 24));
  const frames: Uint8Array[] = [];
  for (let i = 0; i < framePaths.length; i += step) {
    const f = await grayFrame(framePaths[i], signal);
    if (f) frames.push(f);
  }
  if (frames.length < 4) return null;
  const n = frames.length;
  const active = new Uint8Array(W * H);
  // Margem extra em volta da facecam: a moldura/borda dela também se mexe com o streamer
  const ex = exclude && { x0: Math.max(0, exclude.x0 - 0.03) * W, x1: Math.min(1, exclude.x1 + 0.03) * W, y0: Math.max(0, exclude.y0 - 0.05) * H, y1: Math.min(1, exclude.y1 + 0.05) * H };
  for (let p = 0; p < W * H; p++) {
    const x = p % W;
    const y = Math.floor(p / W);
    if (ex && x >= ex.x0 && x <= ex.x1 && y >= ex.y0 && y <= ex.y1) continue;
    let sum = 0;
    let sq = 0;
    for (const f of frames) {
      sum += f[p];
      sq += f[p] * f[p];
    }
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, sq / n - mean * mean));
    if (std > 14) active[p] = 1;
  }
  const colFrac = Array.from({ length: W }, (_, x) => {
    let c = 0;
    for (let y = 0; y < H; y++) c += active[y * W + x];
    return c / H;
  });
  const cols = longestRun(colFrac.map((v) => v > 0.2), 3);
  if (!cols) return null;
  const rowFrac = Array.from({ length: H }, (_, y) => {
    let c = 0;
    for (let x = cols[0]; x <= cols[1]; x++) c += active[y * W + x];
    return c / (cols[1] - cols[0] + 1);
  });
  const rows = longestRun(rowFrac.map((v) => v > 0.2), 2);
  if (!rows) return null;
  const box = { x0: cols[0] / W, x1: (cols[1] + 1) / W, y0: rows[0] / H, y1: (rows[1] + 1) / H };
  const area = (box.x1 - box.x0) * (box.y1 - box.y0);
  // Muito pequeno = ruído; quase a tela toda = não há moldura para tirar
  if (area < 0.12 || (box.x1 - box.x0 > 0.92 && box.y1 - box.y0 > 0.92)) return null;
  return box;
}
