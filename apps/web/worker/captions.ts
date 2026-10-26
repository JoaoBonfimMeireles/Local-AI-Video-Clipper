// Legendas de cada corte em 4 idiomas (português, inglês, espanhol e chinês simplificado): tradução por bloco de
// legenda (uma chamada barata por idioma para todos os cortes) e arquivos SRT/SBV prontos para o YouTube.
import fs from 'node:fs';
import path from 'node:path';
import { translateSegments, type LLMProvider } from '@clipper/ai-providers';
import { buildSbv, buildSrtFromCues, shiftForPauses, type Cue, type SoundPause } from '@clipper/video-processing';

export const CAPTION_LANGS = [
  { code: 'pt', label: 'Português', prompt: 'português do Brasil' },
  { code: 'en', label: 'English', prompt: 'inglês (en)' },
  { code: 'es', label: 'Español', prompt: 'espanhol (es)' },
  { code: 'zh', label: '中文', prompt: 'chinês simplificado (zh-Hans): só caracteres simplificados, sem pinyin' },
] as const;

export type CaptionLang = (typeof CAPTION_LANGS)[number]['code'];

/** Legendas de um corte por idioma, e os títulos do Top N traduzidos. */
export interface ClipCaptions {
  cues: Partial<Record<CaptionLang, Cue[]>>;
  labels: Partial<Record<CaptionLang, string[]>>;
}

type Log = (level: 'info' | 'warn', msg: string) => void;

/**
 * Traduz os blocos de legenda de vários cortes para os 4 idiomas. O idioma original é copiado sem custo;
 * cada outro idioma é UMA chamada (todos os cortes juntos). Idioma que falhar fica de fora (com aviso).
 */
export async function translateCaptions(args: {
  llm: LLMProvider | null;
  clips: { index: number; cues: Cue[]; labels?: string[] }[];
  sourceLang: string;
  guidelines?: string;
  log: Log;
  signal?: AbortSignal;
}): Promise<Record<number, ClipCaptions>> {
  const out: Record<number, ClipCaptions> = {};
  for (const c of args.clips) out[c.index] = { cues: {}, labels: {} };
  const src = (args.sourceLang || 'pt').slice(0, 2).toLowerCase();
  // Os idiomas são independentes: traduzidos ao mesmo tempo (cada um continua sendo uma chamada)
  await Promise.all(
    CAPTION_LANGS.map(async (lang) => {
    if (lang.code === src) {
      for (const c of args.clips) {
        out[c.index].cues[lang.code] = c.cues;
        out[c.index].labels[lang.code] = c.labels ?? [];
      }
      return;
    }
    if (!args.llm) return;
    // Ids sequenciais: blocos de todos os cortes e, depois, os títulos do Top N
    const items: { id: number; text: string }[] = [];
    const where: { clip: number; kind: 'cue' | 'label'; i: number }[] = [];
    for (const c of args.clips) {
      c.cues.forEach((cue, i) => {
        where.push({ clip: c.index, kind: 'cue', i });
        items.push({ id: items.length, text: cue.text });
      });
      (c.labels ?? []).forEach((label, i) => {
        where.push({ clip: c.index, kind: 'label', i });
        items.push({ id: items.length, text: label });
      });
    }
    if (!items.length) return;
    try {
      const tr = await translateSegments({ llm: args.llm, segments: items, targetLang: lang.prompt, sourceLang: args.sourceLang, guidelines: args.guidelines, signal: args.signal, log: args.log });
      for (const c of args.clips) {
        out[c.index].cues[lang.code] = c.cues.map((cue) => ({ ...cue }));
        out[c.index].labels[lang.code] = [...(c.labels ?? [])];
      }
      where.forEach((w, id) => {
        const text = tr.get(id);
        if (!text) return;
        if (w.kind === 'cue') out[w.clip].cues[lang.code]![w.i].text = text;
        else out[w.clip].labels[lang.code]![w.i] = text;
      });
      args.log('info', `Legendas traduzidas para ${lang.label} (${tr.size}/${items.length} blocos)`);
    } catch (e) {
      if (args.signal?.aborted) throw e;
      args.log('warn', `Legendas em ${lang.label} não foram geradas: ${(e as Error).message}`);
    }
    }),
  );
  return out;
}

/**
 * Grava `<base>.<idioma>.srt` e `<base>.<idioma>.sbv` (tempos do vídeo final: depois das pausas de som).
 * Devolve os nomes dos arquivos por idioma.
 */
export function writeCaptionFiles(base: string, captions: ClipCaptions | undefined, pauses: SoundPause[]): Partial<Record<CaptionLang, { srt: string; sbv: string }>> {
  const files: Partial<Record<CaptionLang, { srt: string; sbv: string }>> = {};
  for (const lang of CAPTION_LANGS) {
    const cues = captions?.cues[lang.code];
    if (!cues?.length) continue;
    const timed = shiftForPauses(cues, pauses);
    fs.writeFileSync(`${base}.${lang.code}.srt`, buildSrtFromCues(timed), 'utf8');
    fs.writeFileSync(`${base}.${lang.code}.sbv`, buildSbv(timed), 'utf8');
    files[lang.code] = { srt: path.basename(`${base}.${lang.code}.srt`), sbv: path.basename(`${base}.${lang.code}.sbv`) };
  }
  return files;
}
