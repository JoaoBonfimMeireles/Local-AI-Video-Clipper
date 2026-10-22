import fs from 'node:fs';
import type { ProbeInfo } from '@clipper/shared';
import { runFfprobeJson } from './ffmpeg';

function parseRate(r: string | undefined): number {
  if (!r) return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a || 0;
}

export async function probe(file: string, signal?: AbortSignal): Promise<ProbeInfo> {
  if (!fs.existsSync(file)) throw new Error(`Arquivo não encontrado: ${file}`);
  const j = await runFfprobeJson(['-show_format', '-show_streams', file], signal);
  const streams: any[] = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const duration = Number(j.format?.duration ?? v?.duration ?? audios[0]?.duration ?? 0);

  // Rotação (vídeos de celular): troca largura/altura
  const rotation = Math.abs(
    Number(v?.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0),
  );
  let width = Number(v?.width ?? 0);
  let height = Number(v?.height ?? 0);
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];

  return {
    duration,
    width,
    height,
    fps: parseRate(v?.avg_frame_rate) || parseRate(v?.r_frame_rate) || 30,
    videoCodec: v?.codec_name ?? null,
    audioCodec: audios[0]?.codec_name ?? null,
    audioTracks: audios.length,
    hasAudio: audios.length > 0,
    hasVideo: !!v,
    sizeBytes: Number(j.format?.size ?? fs.statSync(file).size),
    bitRate: j.format?.bit_rate ? Number(j.format.bit_rate) : null,
  };
}

/** Validação de ingestão: retorna lista de problemas bloqueantes. */
export function validateProbe(info: ProbeInfo): string[] {
  const problems: string[] = [];
  if (!info.hasVideo) problems.push('O arquivo não possui faixa de vídeo.');
  if (!info.hasAudio) problems.push('O arquivo não possui faixa de áudio (necessária para transcrição).');
  if (!(info.duration > 5)) problems.push(`Duração inválida ou curta demais (${info.duration.toFixed(1)}s).`);
  if (info.width < 64 || info.height < 64) problems.push(`Resolução inválida (${info.width}x${info.height}).`);
  return problems;
}

/** Probe leve para assets da biblioteca (memes em vídeo podem ter áudio). */
export async function probeAsset(file: string): Promise<{ hasAudio: boolean; duration: number; width: number; height: number }> {
  try {
    const p = await probe(file);
    return { hasAudio: p.hasAudio, duration: p.duration, width: p.width, height: p.height };
  } catch {
    return { hasAudio: false, duration: 0, width: 0, height: 0 };
  }
}
