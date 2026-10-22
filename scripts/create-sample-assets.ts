// Cria memes/sons/imagens de EXEMPLO (gerados pelo FFmpeg, sem download) para testar o pipeline.
// Substitua-os pelos seus próprios arquivos em data/memes, data/audio e data/images.
import fs from 'node:fs';
import path from 'node:path';
import { dataPaths, ensureDataDirs, resolveBinary, runProcess } from '@clipper/shared/server';

async function ff(args: string[], cwd: string) {
  const r = await runProcess(resolveBinary('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd });
  if (r.code !== 0) throw new Error(r.stderrTail);
}

function textPng(text: string, color: string, w = 640, h = 280, size = 120) {
  return [
    '-f', 'lavfi', '-i', `color=c=black@0.0:s=${w}x${h},format=rgba`,
    '-vf', `drawtext=fontfile=font.ttf:text='${text}':fontcolor=${color}:fontsize=${size}:borderw=10:bordercolor=black:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-frames:v', '1',
  ];
}

async function main() {
  ensureDataDirs();
  const work = fs.mkdtempSync(path.join(dataPaths.temp, 'samples-'));
  fs.copyFileSync('C:/Windows/Fonts/arialbd.ttf', path.join(work, 'font.ttf'));
  const out = (kind: string, cat: string, name: string) => {
    const dir = path.join(kind, cat);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
  };

  const jobs: [string, string[]][] = [
    [out(dataPaths.memes, 'humor', 'sample_kkkk.png'), textPng('KKKKKK', 'yellow')],
    [out(dataPaths.memes, 'humor', 'sample_hahaha.png'), textPng('HAHAHA', '0x7CFC00')],
    [out(dataPaths.memes, 'choque', 'sample_oque.png'), textPng('O QUE?!', '0xFF3B30')],
    [out(dataPaths.memes, 'choque', 'sample_absurdo.png'), textPng('ABSURDO', '0xFF9500', 700, 280, 110)],
    [out(dataPaths.memes, 'reacoes', 'sample_uau.png'), textPng('UAU', '0x00E5FF', 480, 280, 150)],
    [out(dataPaths.images, 'stickers', 'sample_atencao.png'), textPng('ATENCAO', 'white', 700, 260, 110)],
    [
      out(dataPaths.memes, 'reacoes', 'sample_reacao.mp4'),
      [
        '-f', 'lavfi', '-i', 'testsrc=s=480x480:d=2:r=30',
        '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*880*t)*exp(-3*t)':d=2:s=48000",
        '-vf', "drawtext=fontfile=font.ttf:text='REACAO':fontcolor=white:fontsize=80:borderw=6:bordercolor=black:x=(w-text_w)/2:y=(h-text_h)/2",
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      ],
    ],
    [out(dataPaths.audio, 'transicao', 'sample_whoosh.wav'), ['-f', 'lavfi', '-i', 'anoisesrc=d=0.7:c=pink:a=0.7,highpass=f=700,lowpass=f=6000,afade=t=in:d=0.3,afade=t=out:st=0.35:d=0.35', '-ar', '48000']],
    [out(dataPaths.audio, 'impacto', 'sample_boom.wav'), ['-f', 'lavfi', '-i', "aevalsrc='0.9*sin(2*PI*(55+60*exp(-10*t))*t)*exp(-3.5*t)':d=1.3:s=48000"]],
    [out(dataPaths.audio, 'impacto', 'sample_ding.wav'), ['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*1320*t)*exp(-5*t)+0.3*sin(2*PI*1980*t)*exp(-6*t)':d=1:s=48000"]],
    [out(dataPaths.audio, 'risadas', 'sample_risada.wav'), ['-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*(300+40*sin(2*PI*5*t))*t)*(0.5+0.5*sin(2*PI*7*t))*exp(-1.1*t)':d=1.6:s=48000"]],
  ];

  for (const [file, args] of jobs) {
    if (fs.existsSync(file)) {
      console.log(`já existe: ${path.relative(dataPaths.root, file)}`);
      continue;
    }
    await ff([...args, file], work);
    console.log(`criado:    ${path.relative(dataPaths.root, file)}`);
  }
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
