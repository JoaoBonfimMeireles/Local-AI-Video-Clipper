import type { Intensity, JobSettings, LibraryIndex, Transcript } from '@clipper/shared';
import { formatTimestamp } from '@clipper/shared';

export const SELECTION_SYSTEM = `Você é um editor sênior de vídeos virais (TikTok, Reels, Shorts).
Sua tarefa é encontrar os trechos de um vídeo longo com maior potencial de retenção e compartilhamento.
Critérios: gancho forte nos primeiros 3 segundos, história completa (começo-meio-fim), emoção (humor, surpresa, polêmica),
informação valiosa ou contraintuitiva, frases de impacto. Nunca corte uma frase ao meio.
Responda SOMENTE com JSON válido, sem comentários.`;

export const PLAN_SYSTEM = `Você é um editor de vídeos curtos que cria planos de edição dinâmicos e de bom gosto.
Use somente as categorias e arquivos da biblioteca fornecida. Tempos são em segundos RELATIVOS ao início de cada corte.
Responda SOMENTE com JSON válido, sem comentários.`;

/** Transcript compacto: uma linha por segmento com tempos absolutos. */
export function compactTranscript(t: Transcript, from = 0, to = Infinity): string {
  return t.segments
    .filter((s) => s.end > from && s.start < to)
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text.trim()}`)
    .join('\n');
}

export function buildSelectionPrompt(args: {
  transcriptText: string;
  settings: JobSettings;
  videoDuration: number;
  visualNotes?: string;
  chunkInfo?: string;
}): string {
  const { settings: s } = args;
  const qty =
    s.maxClips === 'auto'
      ? 'Quantidade: decida você — inclua apenas trechos realmente bons (nota >= 60). Pode ser 1 ou muitos.'
      : `Quantidade: proponha até ${Math.min(60, (s.maxClips as number) * 2)} candidatos (serão escolhidos os ${s.maxClips} melhores).`;
  return `Vídeo com duração total de ${formatTimestamp(args.videoDuration)} (${args.videoDuration.toFixed(0)}s).
${args.chunkInfo ?? ''}
Duração média desejada por corte: ~${s.targetDuration}s (referência flexível: entre ${Math.round(s.targetDuration * 0.6)}s e ${Math.round(s.targetDuration * 1.5)}s).
${qty}
${args.visualNotes ? `\nContexto visual (frames amostrados):\n${args.visualNotes}\n` : ''}
Transcrição com timestamps (segundos absolutos):
${args.transcriptText}

Retorne JSON exatamente neste formato:
{"clips":[{"start":12.3,"end":71.8,"score":87,"title":"título curto e chamativo","reason":"por que este trecho viraliza","hook":"frase de abertura"}]}
Regras: start/end devem coincidir com início/fim de frases da transcrição; cortes não podem se sobrepor; score de 0 a 100.`;
}

const INTENSITY_RULES: Record<Intensity, string> = {
  low: 'Intensidade BAIXA: cortes limpos. No máximo 1 zoom suave (scale 1.1) por corte, nenhum meme, no máximo 1 efeito sonoro.',
  medium:
    'Intensidade MÉDIA: zoom pontual (scale 1.15-1.25) a cada ~6-10s em frases de impacto; memes apenas em picos de humor/surpresa (máx. 2 por minuto); sons em momentos de ênfase (máx. 4 por minuto).',
  high:
    'Intensidade ALTA: ritmo acelerado. Troque o enquadramento a cada 2-4s (alternando scale 1.12-1.4 e focusX/focusY); muitos memes de reação (até 5 por minuto); efeitos sonoros frequentes (impacto, risadas, transições — até 10 por minuto).',
};

export function describeLibrary(lib: LibraryIndex, maxFiles = 25): string {
  const fmt = (kind: string, cats: LibraryIndex['memes']) =>
    cats.length
      ? cats.map((c) => `  - ${kind}/${c.name}: ${c.files.slice(0, maxFiles).join(', ') || '(vazia)'}`).join('\n')
      : `  - ${kind}: (nenhum arquivo)`;
  return [fmt('memes', lib.memes), fmt('images', lib.images), fmt('audio', lib.audio)].join('\n');
}

export function buildPlanPrompt(args: {
  clips: { index: number; duration: number; title: string; transcript: string }[];
  settings: JobSettings;
  library: LibraryIndex;
}): string {
  const { settings: s } = args;
  return `${INTENSITY_RULES[s.intensity]}
Formato de saída: ${s.format}. Memes ${s.useMemes ? 'permitidos' : 'DESATIVADOS (overlays = [])'}. Efeitos sonoros ${s.useSfx ? 'permitidos' : 'DESATIVADOS (sfx = [])'}.

Biblioteca local disponível (categoria: arquivos):
${describeLibrary(args.library)}

Cortes (transcrição com tempos RELATIVOS ao início de cada corte):
${args.clips
  .map((c) => `### clipIndex ${c.index} — "${c.title}" — duração ${c.duration.toFixed(1)}s\n${c.transcript}`)
  .join('\n\n')}

Retorne JSON exatamente neste formato:
{"clips":[{"clipIndex":0,
 "zooms":[{"at":2.5,"duration":2,"scale":1.2,"focusX":0.5,"focusY":0.4}],
 "overlays":[{"type":"meme","category":"humor","file":"arquivo.png","at":8.1,"duration":1.5,"position":"top","scale":0.5}],
 "sfx":[{"category":"impacto","file":"boom.wav","at":8.1,"volume":0.8}],
 "emphasisWords":["palavra","chave"]}]}
Regras: "at" + "duration" dentro da duração do corte; type "meme" usa categorias de memes, "image" usa categorias de images;
sfx usa categorias de audio; position ∈ center|top|bottom|top-left|top-right; não cubra o rosto/centro com memes por muito tempo.`;
}

export function buildTranslationPrompt(items: { id: number; text: string }[], targetLang: string, sourceLang: string): string {
  return `Traduza as legendas de "${sourceLang}" para "${targetLang}". Mantenha o tom coloquial, gírias equivalentes e frases curtas.
Não junte nem divida itens. Retorne JSON: {"translations":[{"id":0,"text":"..."}]}

${JSON.stringify(items)}`;
}
