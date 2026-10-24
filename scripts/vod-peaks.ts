/**
 * Protótipo: melhores momentos de um VOD da Twitch só pela URL (sem baixar o vídeo).
 *   npx tsx scripts/vod-peaks.ts https://www.twitch.tv/videos/123456789 [--sem-audio]
 * Saída em data/vods/<id>/: peaks.json (15 momentos + série de notas) e chart.png (calor da live).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pickVodMoments, scoreBins, VOD_BIN_SECONDS, type VodBin } from '@clipper/clip-selection';
import { formatTimestamp } from '@clipper/shared';
import { dataPaths, pythonScriptPath, resolvePythonBinary, runProcess } from '@clipper/shared/server';
import { audioRmsBins, downloadVodAudio, fetchChatBins, fetchVodMeta } from '../apps/web/worker/twitch-vod';

const log = (level: 'info' | 'warn', msg: string) => console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${level === 'warn' ? 'AVISO ' : ''}${msg}`);

async function main() {
  const url = process.argv[2];
  const noAudio = process.argv.includes('--sem-audio');
  if (!url) throw new Error('Uso: npx tsx scripts/vod-peaks.ts <url do VOD> [--sem-audio]');
  const t0 = Date.now();
  const meta = await fetchVodMeta(url);
  log('info', `VOD ${meta.id}: "${meta.title}" — ${meta.channel} — ${formatTimestamp(meta.duration)}`);
  const dir = path.join(dataPaths.root, 'vods', meta.id);
  fs.mkdirSync(dir, { recursive: true });

  // Chat (cacheado: refazer a análise não baixa de novo)
  const chatCache = path.join(dir, 'chat-bins.json');
  let bins: VodBin[];
  if (fs.existsSync(chatCache)) {
    bins = JSON.parse(fs.readFileSync(chatCache, 'utf8'));
    log('info', `Chat reaproveitado do cache (${bins.reduce((a, b) => a + b.msgs, 0).toLocaleString('pt-BR')} mensagens)`);
  } else {
    const t = Date.now();
    const r = await fetchChatBins(meta, { log });
    bins = r.bins;
    fs.writeFileSync(chatCache, JSON.stringify(bins));
    log('info', `Chat: ${r.total.toLocaleString('pt-BR')} mensagens em ${((Date.now() - t) / 1000).toFixed(0)}s`);
  }

  if (!noAudio) {
    const t = Date.now();
    const audio = await downloadVodAudio(meta, dir, { log });
    log('info', `Áudio pronto em ${((Date.now() - t) / 1000).toFixed(0)}s; medindo a energia…`);
    await audioRmsBins(audio, bins);
  }

  const scores = scoreBins(bins, { hasAudio: !noAudio });
  const moments = pickVodMoments(bins, scores, { count: 15, duration: meta.duration });
  fs.writeFileSync(
    path.join(dir, 'peaks.json'),
    JSON.stringify(
      { meta, binSeconds: VOD_BIN_SECONDS, generatedAt: new Date().toISOString(), moments, series: scores.map((s) => ({ t: s.t, s: +s.score.toFixed(3), c: +s.chat.toFixed(2), r: +s.react.toFixed(2), a: +s.audio.toFixed(2) })) },
      null,
      1,
    ),
  );
  const chart = await runProcess(resolvePythonBinary(), [pythonScriptPath('vod_chart.py'), path.join(dir, 'peaks.json'), path.join(dir, 'chart.png')], { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  if (chart.code !== 0) log('warn', `Gráfico falhou: ${chart.stderrTail.slice(-300)}`);

  console.log(`\nTop ${moments.length} momentos de "${meta.title}":`);
  for (const m of moments) {
    console.log(`#${String(m.rank).padStart(2)} ${formatTimestamp(m.start)}–${formatTimestamp(m.end)} (pico ${formatTimestamp(m.peak)})  nota ${String(m.score).padStart(3)}  ${m.typeLabel.padEnd(26)} ${m.chatPerMin} msg/min  ${m.emotes.join(' ')}`);
  }
  console.log(`\nSaída: ${dir}  (${((Date.now() - t0) / 1000).toFixed(0)}s no total)`);
}

main().catch((e) => {
  console.error(`ERRO: ${(e as Error).message}`);
  process.exit(1);
});
