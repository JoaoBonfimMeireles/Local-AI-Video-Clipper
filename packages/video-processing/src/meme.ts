// Render do compilado do canal de memes: vídeos em sequência dentro da moldura arredondada, logo e título do molde,
// imagens por cima, áudio de fundo, efeitos sonoros e legenda. Mesmas medidas da prévia (MEME_LAYOUT em @clipper/shared).
import fs from 'node:fs';
import path from 'node:path';
import { clipLength, clipOffsets, MEME_H, MEME_LAYOUT, MEME_W, memeDuration, memeLayout, wrapMemeText, type MemeBrand, type MemeCue, type MemeProject } from '@clipper/shared';
import { runFfmpeg, runFfprobeJson, sec } from './ffmpeg';

export interface MemeRenderSpec {
  project: MemeProject;
  brand: MemeBrand;
  /** Caminho absoluto de cada vídeo do compilado (mesma ordem de project.clips). */
  clipPaths: string[];
  /** Legenda queimada por vídeo (tempos relativos ao corte); vazio = sem legenda. */
  cues: MemeCue[][];
  output: string;
  workDir: string;
  hwAccel?: 'none' | 'nvenc';
  threads?: number;
  signal?: AbortSignal;
  onProgress?: (p: number) => void;
}

const num = (n: number, d = 3) => (Number.isFinite(n) ? n : 0).toFixed(d);
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const hex = (c: string) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c.slice(1) : 'ffffff');
/** #RRGGBB → &H00BBGGRR& (ASS). */
const assColor = (c: string) => {
  const h = hex(c);
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
};

function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

const escapeAss = (t: string) => t.replace(/\\/g, '/').replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();

/** Título e legenda num ASS só (posições absolutas no quadro 1080x1920). */
export function buildMemeAss(project: MemeProject, brand: MemeBrand, cues: MemeCue[][]): string {
  const total = memeDuration(project);
  const lines: string[] = [];
  const title = escapeAss(project.title);
  if (title) {
    const c0 = project.clips[0];
    const { lines: tl, size, y0, h } = memeLayout(brand, title, c0?.width ?? 16, c0?.height ?? 9).title;
    const fs = Math.round(size * MEME_W);
    const y = Math.round((y0 + h / 2) * MEME_H);
    const spans = project.titleMode === 'all' ? [{ at: 0, end: total }] : project.titleSpans.filter((s) => s.end > s.at);
    for (const s of spans) {
      lines.push(`Dialogue: 1,${assTime(s.at)},${assTime(Math.min(total, s.end))},Title,,0,0,0,,{\\an5\\pos(${MEME_W / 2},${y})\\fs${fs}\\c${assColor(brand.titleColor)}${project.titleMode === 'spans' ? '\\fad(120,120)' : ''}}${tl.join('\\N')}`);
    }
  }
  const offsets = clipOffsets(project.clips);
  project.clips.forEach((c, i) => {
    const y = Math.round(memeLayout(brand, project.title, c.width, c.height).captionY * MEME_H);
    for (const cue of cues[i] ?? []) {
      const a = Math.max(0, cue.start);
      const b = Math.min(clipLength(c), cue.end);
      const t = escapeAss(cue.text);
      if (!t || b - a < 0.05) continue;
      lines.push(`Dialogue: 0,${assTime(offsets[i] + a)},${assTime(offsets[i] + b)},Caption,,0,0,0,,{\\an2\\pos(${MEME_W / 2},${y})}${wrapMemeText(t.toUpperCase(), 24).slice(0, 2).join('\\N')}`);
    }
  });
  const tSize = Math.round(MEME_LAYOUT.titleSize * MEME_W);
  const cSize = Math.round(MEME_LAYOUT.captionSize * MEME_W);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${MEME_W}
PlayResY: ${MEME_H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Arial Black,${tSize},&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H96000000&,-1,0,0,0,100,100,0,0,1,0,4,5,40,40,0,1
Style: Caption,Arial Black,${cSize},&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H96000000&,-1,0,0,0,100,100,0,0,1,${Math.round(cSize * 0.1)},2,2,40,40,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join('\n')}
`;
}

/** Entrada de imagem por `dur` segundos: estática repete o quadro; GIF/APNG animado toca em loop. */
async function imageInput(file: string, dur: number): Promise<string[]> {
  let frames = 1;
  try {
    const j = await runFfprobeJson(['-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', file]);
    frames = Number(j.streams?.[0]?.nb_read_packets) || 1;
  } catch {
    /* trata como estática */
  }
  return frames > 1 ? ['-ignore_loop', '0', '-t', sec(dur), '-i', file] : ['-loop', '1', '-t', sec(dur), '-i', file];
}

/** Expressão de alfa (0-255) de um retângulo arredondado com borda suavizada, para o geq. */
const roundedAlpha = (r: number) => `255*clip(${r}+0.5-hypot(max(0\\,abs(X-W/2)-(W/2-${r}))\\,max(0\\,abs(Y-H/2)-(H/2-${r})))\\,0\\,1)`;

/** Gera a máscara (cinza) e a moldura (cor da marca) de um tamanho de vídeo. */
async function makeFrameAssets(dir: string, w: number, h: number, border: number, radius: number, color: string, signal?: AbortSignal) {
  const mask = path.join(dir, `mask_${w}x${h}.png`);
  const frame = path.join(dir, `frame_${w}x${h}_${hex(color)}.png`);
  if (!fs.existsSync(mask)) {
    await runFfmpeg(['-f', 'lavfi', '-i', `color=c=white:s=${w}x${h}`, '-frames:v', '1', '-vf', `format=gray,geq=lum='${roundedAlpha(radius)}'`, mask], { signal });
  }
  if (!fs.existsSync(frame)) {
    const fw = w + border * 2;
    const fh = h + border * 2;
    await runFfmpeg(
      ['-f', 'lavfi', '-i', `color=c=0x${hex(color)}:s=${fw}x${fh}`, '-frames:v', '1', '-vf', `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${roundedAlpha(radius + border)}'`, frame],
      { signal },
    );
  }
  return { mask, frame };
}

export async function renderMeme(spec: MemeRenderSpec): Promise<{ duration: number }> {
  const { project, brand } = spec;
  if (!project.clips.length) throw new Error('O compilado não tem vídeos.');
  fs.mkdirSync(spec.workDir, { recursive: true });
  fs.mkdirSync(path.dirname(spec.output), { recursive: true });
  const total = memeDuration(project);
  const offsets = clipOffsets(project.clips);
  const fps = 30;
  const radius = Math.round(brand.radius * MEME_W);
  const border = brand.showFrame ? Math.max(2, Math.round(MEME_LAYOUT.border * MEME_W)) : 0;

  const inputs: string[] = ['-f', 'lavfi', '-i', `color=c=0x${hex(brand.background)}:s=${MEME_W}x${MEME_H}:r=${fps}:d=${num(total)}`];
  const f: string[] = [];
  const audio: string[] = [];
  let idx = 1;
  let label = '0:v';

  // 1) Vídeos: moldura (cor da marca) + vídeo recortado com cantos arredondados, cada um no seu intervalo
  for (let i = 0; i < project.clips.length; i++) {
    const c = project.clips[i];
    const len = clipLength(c);
    const box = memeLayout(brand, project.title, c.width, c.height).video;
    const w = even(box.w * MEME_W);
    const h = even(box.h * MEME_H);
    const x = Math.round(box.x0 * MEME_W + (box.w * MEME_W - w) / 2);
    const y = Math.round(box.y0 * MEME_H);
    const { mask, frame } = await makeFrameAssets(spec.workDir, w, h, border, Math.max(0, Math.min(radius, Math.floor(Math.min(w, h) / 2) - 1)), brand.frame, spec.signal);
    const o = offsets[i];
    const vin = idx++;
    inputs.push('-ss', sec(c.start), '-t', sec(len), '-i', spec.clipPaths[i]);
    const min = idx++;
    inputs.push('-loop', '1', '-t', sec(len), '-i', mask);
    const on = `between(t,${num(o)},${num(o + len)})`;
    if (border) {
      const fin = idx++;
      inputs.push('-loop', '1', '-t', sec(len), '-i', frame);
      f.push(`[${fin}:v]format=rgba,setpts=PTS-STARTPTS+${num(o)}/TB[fr${i}]`);
      f.push(`[${label}][fr${i}]overlay=${x - border}:${y - border}:enable='${on}':eof_action=pass[b${i}]`);
    } else f.push(`[${label}]null[b${i}]`);
    f.push(`[${vin}:v]fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,format=rgba[cv${i}]`);
    f.push(`[${min}:v]format=gray,scale=${w}:${h}[mk${i}]`);
    f.push(`[cv${i}][mk${i}]alphamerge,setpts=PTS-STARTPTS+${num(o)}/TB[cm${i}]`);
    f.push(`[b${i}][cm${i}]overlay=${x}:${y}:enable='${on}':eof_action=pass[v${i}]`);
    label = `v${i}`;
    if (c.hasAudio && c.volume > 0) {
      const ms = Math.round(o * 1000);
      f.push(`[${vin}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${num(Math.min(2, c.volume), 2)},afade=t=out:st=${num(Math.max(0, len - 0.06))}:d=0.06,adelay=${ms}:all=1[ca${i}]`);
      audio.push(`[ca${i}]`);
    }
  }

  // 2) Logo do canal (em cima ou embaixo, no tamanho do molde); animada (GIF/APNG) fica em loop
  const logoFile = brand.logoStill && brand.logoStillFile && fs.existsSync(brand.logoStillFile) ? brand.logoStillFile : brand.logo;
  const lbox = memeLayout(brand, project.title, project.clips[0].width, project.clips[0].height).logo;
  if (lbox && logoFile && fs.existsSync(logoFile)) {
    const k = idx++;
    inputs.push(...(await imageInput(logoFile, total)));
    const lh = even(lbox.h * MEME_H);
    const ly = Math.round(lbox.y0 * MEME_H);
    f.push(`[${k}:v]fps=${fps},scale=${even(MEME_W * 0.9)}:${lh}:force_original_aspect_ratio=decrease,format=rgba[logo]`);
    f.push(`[${label}][logo]overlay=(W-w)/2:${ly}+(${lh}-h)/2:eof_action=pass[vl]`);
    label = 'vl';
  }

  // 3) Imagens por cima (posição pelo centro, largura em fração do quadro)
  for (const [i, im] of project.images.entries()) {
    if (!fs.existsSync(im.file) || im.at >= total) continue;
    const k = idx++;
    const dur = Math.min(im.duration, total - im.at);
    inputs.push(...(await imageInput(im.file, dur)));
    const w = even(im.w * MEME_W);
    const h = even(w / (im.aspect || 1));
    const x = Math.round(im.x * MEME_W - w / 2);
    const y = Math.round(im.y * MEME_H - h / 2);
    f.push(`[${k}:v]fps=${fps},scale=${w}:${h},format=rgba,setpts=PTS-STARTPTS+${num(im.at)}/TB[im${i}]`);
    f.push(`[${label}][im${i}]overlay=${x}:${y}:enable='between(t,${num(im.at)},${num(im.at + dur)})':eof_action=pass[vi${i}]`);
    label = `vi${i}`;
  }

  // 4) Título e legenda (por cima de tudo)
  const ass = buildMemeAss(project, brand, spec.cues);
  fs.writeFileSync(path.join(spec.workDir, 'meme.ass'), ass, 'utf8');
  f.push(`[${label}]subtitles=filename=meme.ass,format=yuv420p[vout]`);

  // 5) Áudio: base silenciosa do tamanho do compilado + áudio dos vídeos + fundo + efeitos
  f.push(`anullsrc=r=48000:cl=stereo,atrim=0:${num(total)}[abase]`);
  if (project.music && fs.existsSync(project.music.file) && project.music.volume > 0) {
    const k = idx++;
    inputs.push('-stream_loop', '-1', '-ss', sec(Math.max(0, project.music.offset)), '-i', project.music.file);
    f.push(`[${k}:a]atrim=0:${num(total)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${num(Math.min(2, project.music.volume), 2)},afade=t=out:st=${num(Math.max(0, total - 1))}:d=1[mus]`);
    audio.push('[mus]');
  }
  project.sfx.forEach((s, i) => {
    if (!fs.existsSync(s.file) || s.at >= total) return;
    const k = idx++;
    inputs.push('-i', s.file);
    const sd = Math.min(10, Math.max(0.2, s.duration || 3));
    f.push(`[${k}:a]atrim=0:${num(sd)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${num(Math.min(2, s.volume), 2)},adelay=${Math.round(s.at * 1000)}:all=1[sx${i}]`);
    audio.push(`[sx${i}]`);
  });
  f.push(audio.length ? `[abase]${audio.join('')}amix=inputs=${audio.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]` : `[abase]anull[aout]`);

  const threads = String(Math.max(1, Math.min(32, Math.floor(spec.threads ?? 4))));
  const codec = (hw: string | undefined) =>
    hw === 'nvenc' ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '22', '-b:v', '0'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high'];
  const args = (hw: string | undefined) => [
    '-threads', threads,
    ...inputs,
    '-filter_complex', f.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    ...codec(hw),
    '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', sec(total),
    '-movflags', '+faststart',
    spec.output,
  ];
  fs.writeFileSync(path.join(spec.workDir, 'ffmpeg-args.json'), JSON.stringify(args(spec.hwAccel), null, 2));
  try {
    await runFfmpeg(args(spec.hwAccel), { cwd: spec.workDir, signal: spec.signal, expectedDuration: total, onProgress: spec.onProgress });
  } catch (e) {
    // NVENC indisponível/ocupado: tenta de novo em CPU
    if (spec.hwAccel !== 'nvenc' || spec.signal?.aborted) throw e;
    await runFfmpeg(args('none'), { cwd: spec.workDir, signal: spec.signal, expectedDuration: total, onProgress: spec.onProgress });
  }
  return { duration: total };
}
