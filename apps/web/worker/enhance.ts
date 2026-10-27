// "Melhorar qualidade" do editor manual: só a área marcada (ex.: a câmera pequena do streamer) passa pelo Real-ESRGAN,
// no trecho de cada enquadramento. O render usa o vídeo melhorado no lugar do recorte do original.
import fs from 'node:fs';
import path from 'node:path';
import type { FrameBox, ManualFrame, UpscaleModel } from '@clipper/shared';
import { runFfmpeg, sec, upscaleVideo } from '@clipper/video-processing';

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** Retângulo (px pares) de uma caixa em frações no quadro width x height. */
export function cropPx(box: FrameBox, width: number, height: number) {
  const x = Math.max(0, Math.round(box.x0 * width));
  const y = Math.max(0, Math.round(box.y0 * height));
  return { x, y, w: even(Math.min(width - x, (box.x1 - box.x0) * width)), h: even(Math.min(height - y, (box.y1 - box.y0) * height)) };
}

/** Lado menor depois de melhorar: 4x a área, até 1080 (o render ainda ajusta ao tamanho do bloco). */
export const enhanceTarget = (w: number, h: number) => Math.min(1080, even(Math.min(w, h) * 4));

/**
 * Preenche enhancedTop/enhancedBottom dos enquadramentos que pediram "Melhorar qualidade". `input` começa no instante
 * `start` do plano (mesma entrada do render). Falha numa área = segue sem melhorar (avisa no log).
 */
export async function enhanceManualFrames(args: {
  frames: ManualFrame[];
  input: string;
  start: number;
  duration: number;
  source: { width: number; height: number; fps?: number };
  workDir: string;
  signal: AbortSignal;
  log: (level: 'info' | 'warn', msg: string) => void;
  onProgress: (p: number) => void;
}): Promise<ManualFrame[]> {
  const jobs = args.frames.flatMap((fr, i) =>
    (
      [
        ['top', fr.enhanceTop, fr.box],
        ['bottom', fr.enhanceBottom, fr.box2],
      ] as const
    )
      .filter((x): x is readonly ['top' | 'bottom', UpscaleModel, FrameBox] => !!x[1] && !!x[2] && fr.at < args.duration)
      .map(([which, model, box]) => ({ i, which, model, box })),
  );
  if (!jobs.length) return args.frames;
  const out = args.frames.map((f) => ({ ...f }));
  for (const [n, j] of jobs.entries()) {
    const fr = out[j.i];
    const len = Math.min(args.duration, fr.end) - Math.max(0, fr.at);
    if (len < 0.2) continue;
    const px = cropPx(j.box, args.source.width, args.source.height);
    const dir = path.join(args.workDir, `enhance_${j.i}_${j.which}`);
    fs.mkdirSync(dir, { recursive: true });
    const crop = path.join(dir, 'crop.mp4');
    const result = path.join(dir, 'enhanced.mp4');
    const label = `${j.which === 'top' ? 'área de cima' : 'área de baixo'} ${fr.at.toFixed(1)}–${(fr.at + len).toFixed(1)}s`;
    try {
      // Recorte quase sem perda (a IA trabalha melhor sem blocos de compressão novos), a no máximo 30 quadros/s:
      // metade do trabalho da GPU em lives a 60 fps; o render repete os quadros
      await runFfmpeg(
        ['-ss', sec(args.start + Math.max(0, fr.at)), '-t', sec(len), '-i', args.input, '-an', '-vf', `crop=${px.w}:${px.h}:${px.x}:${px.y},fps=${Math.min(30, Math.round(args.source.fps || 30))}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', crop],
        { signal: args.signal },
      );
      const r = await upscaleVideo({
        input: crop,
        output: result,
        target: enhanceTarget(px.w, px.h),
        model: j.model,
        workDir: dir,
        signal: args.signal,
        onProgress: (_phase, p) => args.onProgress((n + p) / jobs.length),
        log: (m) => args.log('info', m),
      });
      if (r) {
        out[j.i] = { ...out[j.i], [j.which === 'top' ? 'enhancedTop' : 'enhancedBottom']: { file: result, w: r.width, h: r.height } };
        args.log('info', `Qualidade melhorada (${label}): ${px.w}x${px.h} → ${r.width}x${r.height}`);
      } else args.log('info', `Melhorar qualidade (${label}): a área já é grande (${px.w}x${px.h}), mantida como está.`);
    } catch (e) {
      if (args.signal.aborted) throw e;
      args.log('warn', `Não deu para melhorar a qualidade (${label}); segue sem: ${(e as Error).message.split('\n')[0]}`);
    }
    args.onProgress((n + 1) / jobs.length);
  }
  return out;
}
