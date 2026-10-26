// Narrador: lê o roteiro com voz neural (edge-tts, com a voz do Windows de reserva), anima a boca
// do personagem 2D pela amplitude da fala e o coloca no canto inferior esquerdo do corte já renderizado.
import fs from 'node:fs';
import path from 'node:path';
import { transcribe } from '@clipper/ai-providers';
import { curiosityTemplate, type AppSettings, type CuriosityIdea } from '@clipper/shared';
import { dataPaths, pythonScriptPath, resolvePythonBinary, runProcess } from '@clipper/shared/server';
import { buildAss, probe, runFfmpeg } from '@clipper/video-processing';

const FPS = 15;
/** A narração entra um pouco depois do primeiro quadro (o gancho aparece antes). */
const LEAD = 0.3;

/** Ilustração do narrador escolhida pelo usuário; sem ela, usa o personagem desenhado no código. */
export const NARRATOR_IMAGE = path.join(dataPaths.root, 'narrator', 'apresentador.png');

/** Geração em andamento: vários pedidos ao mesmo tempo (prévia carrega 6 sprites) esperam a mesma. */
let building: Promise<string> | null = null;

/** Sprites do personagem (gerados uma vez por versão da imagem, em cache). */
export function narratorSprites(signal?: AbortSignal): Promise<string> {
  building ??= buildSprites(signal).finally(() => (building = null));
  return building;
}

async function buildSprites(signal?: AbortSignal): Promise<string> {
  if (fs.existsSync(NARRATOR_IMAGE)) {
    const st = fs.statSync(NARRATOR_IMAGE);
    const dir = path.join(dataPaths.root, 'cache', 'narrator', `imagem-v2-${st.size}-${Math.floor(st.mtimeMs)}`);
    if (fs.existsSync(path.join(dir, 'm2_e1.png'))) return dir;
    const res = await runProcess(resolvePythonBinary(), [pythonScriptPath('narrator_from_image.py'), '--image', NARRATOR_IMAGE, '--out', dir], { signal, timeoutMs: 180_000 });
    if (res.code === 0) return dir;
    console.warn(`[narrador] imagem não pôde ser usada, usando o desenho padrão: ${res.stderrTail.slice(-300)}`);
  }
  const dir = path.join(dataPaths.root, 'cache', 'narrator', 'apresentador-v2');
  if (fs.existsSync(path.join(dir, 'm2_e1.png'))) return dir;
  const res = await runProcess(resolvePythonBinary(), [pythonScriptPath('narrator_sprites.py'), '--out', dir], { signal, timeoutMs: 60_000 });
  if (res.code !== 0) throw new Error(`Não foi possível desenhar o narrador: ${res.stderrTail.slice(-400)}`);
  return dir;
}

/** Voz neural pt-BR (Microsoft Antonio, via edge-tts: gratuita, sem chave, precisa de internet). */
const NEURAL_VOICE = process.env.NARRATOR_VOICE || 'pt-BR-AntonioNeural';

/**
 * Texto → WAV. Primeiro a voz neural (natural, calorosa); se o edge-tts não estiver instalado ou estiver sem
 * internet, cai para a voz do Windows (SAPI, offline, mais robótica).
 */
export async function synthesizeSpeech(text: string, outWav: string, signal?: AbortSignal): Promise<'neural' | 'sapi'> {
  const txt = `${outWav}.txt`;
  fs.writeFileSync(txt, text, 'utf8');
  const mp3 = `${outWav}.mp3`;
  const neural = await runProcess(resolvePythonBinary(), ['-m', 'edge_tts', '--voice', NEURAL_VOICE, '--rate=+6%', '--pitch=-2Hz', '-f', txt, '--write-media', mp3], {
    signal,
    timeoutMs: 120_000,
  }).catch(() => null);
  if (neural?.code === 0 && fs.existsSync(mp3)) {
    await runFfmpeg(['-i', mp3, '-ar', '48000', '-ac', '1', outWav], { signal });
    return 'neural';
  }
  if (process.platform !== 'win32') throw new Error(`Voz neural indisponível: ${neural?.stderrTail.slice(-300) ?? 'edge-tts não encontrado'}`);
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'pt*' } | Select-Object -First 1",
    'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
    '$s.Rate = 1',
    '$s.SetOutputToWaveFile($env:TTS_OUT)',
    '$s.Speak([IO.File]::ReadAllText($env:TTS_TXT, [Text.Encoding]::UTF8))',
    '$s.Dispose()',
  ].join('; ');
  const res = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, TTS_TXT: txt, TTS_OUT: outWav },
    signal,
    timeoutMs: 120_000,
  });
  if (res.code !== 0 || !fs.existsSync(outWav)) throw new Error(`Síntese de voz falhou: ${res.stderrTail.slice(-400)}`);
  return 'sapi';
}

/** Abertura da boca por quadro (0 fechada, 1 meio, 2 aberta), pela energia RMS da fala a 15 quadros/s. */
async function mouthTrack(wav: string, workDir: string, signal?: AbortSignal): Promise<number[]> {
  const pcm = path.join(workDir, 'tts.pcm');
  await runFfmpeg(['-i', wav, '-ac', '1', '-ar', '16000', '-f', 's16le', pcm], { signal });
  const buf = fs.readFileSync(pcm);
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const step = Math.round(16000 / FPS);
  const rms: number[] = [];
  for (let i = 0; i < samples.length; i += step) {
    let acc = 0;
    const end = Math.min(samples.length, i + step);
    for (let k = i; k < end; k++) acc += samples[k] * samples[k];
    rms.push(Math.sqrt(acc / Math.max(1, end - i)));
  }
  const ref = [...rms].sort((a, b) => a - b)[Math.floor(rms.length * 0.95)] || 1;
  // Média móvel de 3 quadros + histerese: a boca não troca de estado a cada quadro (fica natural, sem "tremer")
  const smooth = rms.map((_, i) => (rms[Math.max(0, i - 1)] + 2 * rms[i] + rms[Math.min(rms.length - 1, i + 1)]) / 4 / ref);
  const states: number[] = [];
  let cur = 0;
  let held = 0;
  for (const x of smooth) {
    const want = x < 0.1 ? 0 : x < 0.5 ? 1 : 2;
    held++;
    // Muda só depois de 2 quadros no estado atual; nunca pula direto de fechada para aberta (passa pela meia)
    if (want !== cur && held >= 2) {
      cur = Math.abs(want - cur) > 1 ? 1 : want;
      held = 0;
    }
    states.push(cur);
  }
  return states;
}

const assColor = (hex: string, alpha = '00') => {
  const h = hex.replace('#', '');
  return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
};
const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assText = (s: string) => s.replace(/[{}]/g, '').replace(/\r?\n/g, ' ');

/**
 * Coloca o narrador no corte: congela o último quadro se a fala for mais longa, abaixa o som original,
 * mistura a voz e queima a legenda da narração + o gancho no topo (início) e o CTA (fim).
 * Substitui `video` e devolve a nova duração.
 */
export async function addNarrator(opts: {
  video: string;
  idea: CuriosityIdea;
  width: number;
  height: number;
  app: AppSettings;
  workDir: string;
  signal?: AbortSignal;
  log: (level: 'info' | 'warn', msg: string) => void;
}): Promise<number> {
  const { idea, width: W, height: H, workDir, signal } = opts;
  fs.mkdirSync(workDir, { recursive: true });
  const tpl = curiosityTemplate(idea.template);
  const sprites = await narratorSprites(signal);

  const ttsWav = path.join(workDir, 'narracao.wav');
  const voice = await synthesizeSpeech(idea.script, ttsWav, signal);
  if (voice === 'sapi') opts.log('warn', 'Voz neural indisponível (instale com: .venv\Scripts\pip install edge-tts); usando a voz do Windows');
  const tts = await probe(ttsWav, signal);
  const src = await probe(opts.video, signal);
  const total = Math.max(src.duration, tts.duration + LEAD + 0.6);
  opts.log('info', `Narrador: ${tts.duration.toFixed(1)}s de fala${total > src.duration + 0.05 ? ` (vídeo estendido em ${(total - src.duration).toFixed(1)}s com o último quadro)` : ''}`);

  // Boca: um sprite por quadro de 1/15s (sem piscar)
  const mouth = await mouthTrack(ttsWav, workDir, signal);
  const frames = Math.ceil(total * FPS);
  const lines = ['ffconcat version 1.0'];
  let prev = '';
  let run = 0;
  const flush = () => {
    if (!prev) return;
    lines.push(`file '${path.join(sprites, prev).replace(/\\/g, '/')}'`, `duration ${(run / FPS).toFixed(4)}`);
  };
  for (let f = 0; f < frames; f++) {
    const k = f - Math.round(LEAD * FPS);
    const m = k >= 0 && k < mouth.length ? mouth[k] : 0;
    const name = `m${m}_e0.png`;
    if (name === prev) run++;
    else {
      flush();
      prev = name;
      run = 1;
    }
  }
  flush();
  lines.push(`file '${path.join(sprites, prev).replace(/\\/g, '/')}'`);
  fs.writeFileSync(path.join(workDir, 'narrador.ffconcat'), lines.join('\n'), 'utf8');

  // Legenda da narração: tempos das palavras pelo Whisper na própria voz sintetizada
  let words: { start: number; end: number; word: string }[] = [];
  try {
    const wav16 = path.join(workDir, 'narracao16k.wav');
    await runFfmpeg(['-i', ttsWav, '-ac', '1', '-ar', '16000', wav16], { signal });
    const t = await transcribe({ audioPath: wav16, outputJson: path.join(workDir, 'narracao-whisper.json'), model: opts.app.whisperModel, device: opts.app.whisperDevice, language: 'pt', threads: opts.app.threads, signal });
    words = t.segments.flatMap((sg) => sg.words).map((w) => ({ ...w, start: w.start + LEAD, end: w.end + LEAD }));
  } catch (e) {
    if (signal?.aborted) throw e;
    opts.log('warn', `Legenda da narração indisponível: ${(e as Error).message}`);
  }
  let ass = buildAss(words, { width: W, height: H, intensity: 'medium', baseline: 0.64 });
  const fs1 = Math.round(W * 0.07);
  const styles = [
    `Style: Hook,Arial Black,${fs1},&H00FFFFFF&,&H00FFFFFF&,${assColor(tpl.to)},${assColor(tpl.from)},-1,0,0,0,100,100,0,0,3,${Math.round(fs1 * 0.35)},0,8,${Math.round(W * 0.07)},${Math.round(W * 0.07)},${Math.round(H * 0.09)},1`,
    `Style: Cta,Arial Black,${Math.round(fs1 * 0.8)},&H00FFFFFF&,&H00FFFFFF&,${assColor(tpl.from)},${assColor(tpl.to)},-1,0,0,0,100,100,0,0,3,${Math.round(fs1 * 0.3)},0,8,${Math.round(W * 0.08)},${Math.round(W * 0.08)},${Math.round(H * 0.09)},1`,
    `Style: Badge,Arial Black,${Math.round(fs1 * 0.55)},&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H80000000&,-1,0,0,0,100,100,0,0,3,${Math.round(fs1 * 0.25)},0,7,${Math.round(W * 0.05)},0,${Math.round(H * 0.035)},1`,
  ];
  ass = ass.replace(/(Style: Main,[^\n]*\n)/, `$1${styles.join('\n')}\n`);
  const hookEnd = Math.min(3.4, total * 0.4);
  const events = [
    `Dialogue: 2,${assTime(0)},${assTime(hookEnd)},Hook,,0,0,0,,{\\fad(120,200)\\t(0,180,\\fscx112\\fscy112)\\t(180,320,\\fscx100\\fscy100)}${assText(idea.hook)}`,
    `Dialogue: 1,${assTime(0)},${assTime(total)},Badge,,0,0,0,,${assText(idea.spoiler ? `ALERTA DE SPOILER · ${tpl.label.toUpperCase()}` : tpl.label.toUpperCase())}`,
  ];
  if (idea.cta.trim() && total > 8) events.push(`Dialogue: 2,${assTime(total - 3)},${assTime(total)},Cta,,0,0,0,,{\\fad(200,0)}${assText(idea.cta)}`);
  ass = `${ass.trimEnd()}\n${events.join('\n')}\n`;
  fs.writeFileSync(path.join(workDir, 'narracao.ass'), ass, 'utf8');

  const cw = Math.round(W * 0.42);
  const pad = Math.max(0, total - src.duration);
  const filter = [
    `[0:v]tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)},setpts=PTS-STARTPTS[v0]`,
    `[1:v]scale=${cw}:-1,format=rgba[ch]`,
    // Balança de leve (respira) enquanto fala
    `[v0][ch]overlay=x=${Math.round(W * 0.03)}:y=H-h-${Math.round(H * 0.05)}+6*sin(t*2.4):eval=frame:shortest=0[v1]`,
    `[v1]subtitles=filename=narracao.ass[vout]`,
    src.hasAudio ? `[0:a]volume=0.22,apad[a0]` : `anullsrc=r=48000:cl=stereo[a0]`,
    `[2:a]aresample=48000,adelay=${Math.round(LEAD * 1000)}:all=1,volume=1.5,apad[a1]`,
    `[a0][a1]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[aout]`,
  ].join(';');
  const out = path.join(workDir, 'narrado.mp4');
  const encode = (codec: string[]) =>
    runFfmpeg(
      ['-i', opts.video, '-f', 'concat', '-safe', '0', '-i', 'narrador.ffconcat', '-i', ttsWav, '-filter_complex', filter, '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(3), ...codec, '-pix_fmt', 'yuv420p', '-r', String(Math.round(src.fps) || 30), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out],
      { cwd: workDir, signal, expectedDuration: total },
    );
  if (opts.app.hwAccel === 'nvenc') {
    await encode(['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '21']).catch((e) => {
      if (signal?.aborted) throw e;
      return encode(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21']);
    });
  } else await encode(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21']);
  fs.copyFileSync(out, opts.video);
  return total;
}
