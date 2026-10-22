// Gera um vídeo de teste curto (~2-3 min) 100% local: fala via TTS do Windows (voz pt-BR)
// + vídeo sintético do FFmpeg com uma "legenda antiga" queimada (para testar a remoção).
// Uso: npx tsx scripts/make-test-video.ts [saida.mp4]
import fs from 'node:fs';
import path from 'node:path';
import { dataPaths, ensureDataDirs, resolveBinary, runProcess } from '@clipper/shared/server';

const SCRIPT = `
Olá, pessoal, sejam muito bem-vindos a mais um episódio do nosso podcast. Hoje o assunto é dinheiro, e eu vou contar uma história que ninguém acredita.
Você sabia que noventa por cento das pessoas desistem do primeiro negócio antes de completar um ano? Pois é. E o motivo não é falta de dinheiro. O motivo é falta de paciência.
Quando eu comecei, eu tinha só duzentos reais no bolso. Duzentos reais! E eu gastei metade em um curso que prometia me deixar milionário em uma semana. Hahaha, claro que não funcionou.
Mas aí veio a virada. Eu descobri um segredo simples. O segredo é: venda primeiro, construa depois. Parece óbvio, né? Mas quase ninguém faz isso.
Deixa eu te dar um exemplo absurdo. Um amigo meu passou dois anos criando um aplicativo perfeito. Dois anos! No dia do lançamento, sabe quantas pessoas baixaram? Três. A mãe dele, a namorada e ele mesmo.
Então qual é a lição aqui? A lição é que o mercado não liga para o quanto você se esforçou. O mercado liga para o problema que você resolve.
Agora, uma pergunta que vocês sempre me fazem: vale a pena largar o emprego para empreender? A minha resposta é polêmica. Não. Pelo menos não no começo.
Mantenha o emprego, teste a ideia nas horas vagas, e só pule quando a ideia já estiver pagando as suas contas. Isso é coragem com estratégia, e não loucura.
Último ponto, e esse é o mais importante de todos. Cuidado com quem você escuta. Tem muita gente vendendo atalho, e atalho no mundo dos negócios quase sempre é um precipício.
Se esse episódio te ajudou, compartilha com aquele amigo que vive falando que vai abrir um negócio e nunca abre. Valeu, pessoal, até a próxima!
`.trim();

async function main() {
  ensureDataDirs();
  const out = path.resolve(process.argv[2] ?? path.join(dataPaths.input, 'teste_podcast.mp4'));
  const work = fs.mkdtempSync(path.join(dataPaths.temp, 'testvideo-'));
  const txt = path.join(work, 'script.txt');
  const wav = path.join(work, 'voice.wav');
  fs.writeFileSync(txt, SCRIPT, 'utf8');

  console.log('Sintetizando fala (Microsoft Maria, pt-BR)...');
  const ps = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    "try { $s.SelectVoice('Microsoft Maria Desktop') } catch {};",
    '$s.Rate = 1;',
    '$s.SetOutputToWaveFile($env:CLIP_OUT_WAV);',
    '$s.Speak([IO.File]::ReadAllText($env:CLIP_IN_TXT, [Text.Encoding]::UTF8));',
    '$s.Dispose()',
  ].join(' ');
  const r = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, CLIP_OUT_WAV: wav, CLIP_IN_TXT: txt },
  });
  if (r.code !== 0 || !fs.existsSync(wav)) throw new Error(`TTS falhou: ${r.stderrTail}`);

  console.log('Gerando vídeo 1920x1080 com FFmpeg...');
  // Fonte copiada para a pasta de trabalho: evita escapar "C:" dentro do filtergraph.
  const font = 'C:/Windows/Fonts/arialbd.ttf';
  if (fs.existsSync(font)) fs.copyFileSync(font, path.join(work, 'font.ttf'));
  const drawSub = fs.existsSync(path.join(work, 'font.ttf'))
    ? ",drawbox=x=360:y=900:w=1200:h=90:color=black@0.6:t=fill,drawtext=fontfile=font.ttf:text='LEGENDA ANTIGA QUEIMADA NO VIDEO':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=922"
    : '';
  const res = await runProcess(
    resolveBinary('ffmpeg'),
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
      '-i', wav,
      '-filter_complex', `[0:v]hue=s=0.6${drawSub}[v];[1:a]aresample=48000,pan=stereo|c0=c0|c1=c0[a]`,
      '-map', '[v]', '-map', '[a]',
      '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', out,
    ],
    { cwd: work },
  );
  if (res.code !== 0) throw new Error(`FFmpeg falhou: ${res.stderrTail}`);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`OK: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
