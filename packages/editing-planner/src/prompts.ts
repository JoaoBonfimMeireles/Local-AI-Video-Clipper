import type { Intensity, JobSettings, LibraryIndex, Transcript } from '@clipper/shared';
import type { VideoKnowledge } from './schemas';
import { formatTimestamp } from '@clipper/shared';

export const SELECTION_SYSTEM = `Você é um editor sênior de vídeos virais (TikTok, Reels, Shorts).
Sua tarefa é encontrar os trechos de um vídeo longo com maior potencial de retenção e compartilhamento.
Critérios: gancho forte nos primeiros 3 segundos, história completa (começo-meio-fim), emoção (humor, surpresa, polêmica),
informação valiosa ou contraintuitiva, frases de impacto. Nunca corte uma frase ao meio.
Responda SOMENTE com JSON válido, sem comentários.`;

export const PLAN_SYSTEM = `Você é um editor de vídeos curtos exigente, que pensa como um diretor de câmera.
Cada decisão precisa ter motivo: enquadre quem está falando, mostre a reação do outro quando ela importa,
abra o plano quando as pessoas interagem e aproxime no que está sendo mostrado (comida, objeto, tela).
Use somente as categorias e arquivos da biblioteca fornecida. Tempos são em segundos RELATIVOS ao início de cada corte.
Responda SOMENTE com JSON válido, sem comentários.`;

export const ANALYSIS_SYSTEM = `Você é um analista de conteúdo audiovisual. Pela transcrição e pelos frames, descreva o vídeo
de forma objetiva e reutilizável: quem aparece, onde cada pessoa fica no quadro, do que se fala e quais momentos têm
potencial para cortes curtos. Esta análise será guardada e usada depois para criar cortes diferentes, então seja
completo e preciso nos tempos. Escreva as descrições em português.
Responda SOMENTE com JSON válido, sem comentários.`;

export function buildAnalysisPrompt(args: { transcriptText: string; videoDuration: number; visualNotes?: string; chunkInfo?: string }): string {
  return `Vídeo com duração total de ${formatTimestamp(args.videoDuration)} (${args.videoDuration.toFixed(0)}s).
${args.chunkInfo ?? ''}
${args.visualNotes ? `Frames amostrados (as imagens anexadas seguem esta ordem):\n${args.visualNotes}\n` : ''}
Transcrição com timestamps (segundos absolutos):
${args.transcriptText}

Retorne JSON neste formato:
{"summary":"resumo do vídeo em 3-6 frases",
 "format":"ex.: podcast com 2 pessoas lado a lado; vlog de comida com câmera na mão; tela de notebook",
 "speakers":[{"id":"A","description":"homem de boné, apresentador","position":"esquerda do quadro (x≈0.3)"}],
 "topics":["tema 1","tema 2"],
 "moments":[{"start":12.3,"end":31.0,"type":"hook|story|punchline|insight|reaction|quote|visual|conclusion|other",
   "description":"o que acontece e por que importa","quote":"frase literal curta","speaker":"A","strength":85,
   "visual":"o que aparece na tela (ex.: close na coxinha, os dois rindo)"}]}
Regras: moments deve cobrir o vídeo INTEIRO em blocos de 5 a 40s, sem lacunas grandes, com start/end coincidindo com
início/fim de frases; strength (0-100) = potencial para viralizar isoladamente; position com x aproximado (0=esquerda, 1=direita).`;
}

export function knowledgeToText(k: VideoKnowledge): string {
  const speakers = k.speakers.map((p) => `  - ${p.id}: ${p.description}${p.position ? ` — ${p.position}` : ''}`).join('\n');
  const moments = k.moments
    .map(
      (m) =>
        `[${m.start.toFixed(1)}-${m.end.toFixed(1)}] (${m.type}, força ${Math.round(m.strength)}${m.speaker ? `, fala ${m.speaker}` : ''}) ${m.description}${m.quote ? ` — "${m.quote}"` : ''}${m.visual ? ` [visual: ${m.visual}]` : ''}`,
    )
    .join('\n');
  return `Resumo: ${k.summary}
Formato: ${k.format}
Pessoas:
${speakers || '  (não identificadas)'}
Temas: ${k.topics.join(', ')}
Momentos (tempos absolutos):
${moments}`;
}

export function buildSelectionFromKnowledgePrompt(args: { knowledge: VideoKnowledge; settings: JobSettings; videoDuration: number }): string {
  const { settings: s } = args;
  const qty =
    s.maxClips === 'auto'
      ? 'Quantidade: decida você — inclua apenas cortes realmente bons (nota >= 60). Seja crítico: melhor 2 ótimos que 6 medianos.'
      : `Quantidade: proponha até ${Math.min(60, (s.maxClips as number) * 2)} candidatos (serão escolhidos os ${s.maxClips} melhores).`;
  return `Duração total do vídeo: ${args.videoDuration.toFixed(0)}s.
Duração desejada por corte: ~${s.targetDuration}s (flexível: entre ${Math.round(s.targetDuration * 0.6)}s e ${Math.round(s.targetDuration * 1.5)}s, somando os trechos).
${qty}

Análise do vídeo:
${knowledgeToText(args.knowledge)}

Monte cada corte com 1 a 4 trechos ("segments"), na ordem em que devem aparecer. Você PODE juntar trechos distantes
quando isso deixar o corte mais forte (ex.: abrir com a conclusão/frase de impacto do final e depois mostrar o contexto
do início; ou juntar falas boas espalhadas sobre o mesmo assunto). Cada corte precisa fazer sentido sozinho para quem
nunca viu o vídeo: gancho nos primeiros 3s, começo-meio-fim, sem depender de contexto ausente.

Retorne JSON exatamente neste formato:
{"clips":[{"segments":[{"start":120.4,"end":131.0},{"start":12.3,"end":55.8}],"score":87,"title":"título curto e chamativo","reason":"por que funciona (e por que juntou os trechos, se juntou)","hook":"frase de abertura"}]}
Regras: start/end de cada trecho devem coincidir com início/fim de frases (use os tempos dos momentos); cortes não
podem repetir trechos entre si; score de 0 a 100.`;
}

/**
 * Anexa as diretrizes editoriais do usuário ao prompt de sistema. Elas têm prioridade sobre o estilo
 * padrão, mas não sobre o formato JSON nem sobre os limites técnicos (validados depois com Zod).
 */
export function withGuidelines(system: string, guidelines?: string): string {
  const g = guidelines?.trim();
  if (!g) return system;
  return `${system}

DIRETRIZES DO EDITOR (definidas pelo dono do canal — siga-as com prioridade sobre o estilo padrão,
sem quebrar o formato JSON pedido):
"""
${g.slice(0, 6000)}
"""`;
}

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
  /** Idioma em que título, descrição e hashtags devem ser escritos. */
  language: string;
  /** Pessoas e formato do vídeo (do conhecimento em cache). */
  knowledge?: VideoKnowledge | null;
  /** Frames de cada corte: "imagem N: t=Xs" (as imagens seguem anexadas nesta ordem). */
  visualByClip?: Map<number, string>;
}): string {
  const { settings: s } = args;
  const vertical = s.format === 'vertical_blur' || s.format === 'vertical_crop';
  const people = args.knowledge
    ? `Vídeo: ${args.knowledge.format}\nPessoas: ${args.knowledge.speakers.map((p) => `${p.id} = ${p.description} (${p.position})`).join('; ') || 'não identificadas'}\n`
    : '';
  return `${INTENSITY_RULES[s.intensity]}
${people}
ENQUADRAMENTO ("shots") — saída em ${vertical ? 'VERTICAL 9:16 a partir de um vídeo horizontal' : s.format === 'square' ? 'QUADRADO 1:1' : 'formato original'}:
- "focus": recorta uma janela do vídeo original centrada em focusX/focusY (0-1, posição no quadro ORIGINAL).
  scale 1 = altura inteira (em 9:16 mostra ~1 pessoa); scale 1.3-1.8 = aproxima (rosto em reação, comida, objeto, tela).
- "wide": mostra o quadro inteiro (todas as pessoas)${vertical ? ', com fundo desfocado' : ''}.
- Analise os frames: veja onde cada pessoa está e QUEM está falando em cada momento (cruze com a transcrição).
  Enquadre quem fala; quando a outra pessoa responde ou reage de forma marcante, corte para ela; use "wide" quando as
  duas interagem/riem juntas ou quando ninguém se destaca; aproxime (scale maior) quando algo é mostrado.
- Cubra o corte inteiro com shots contíguos; troque de shot a cada 2-8s conforme a fala, nunca sem motivo.
- NUNCA corte a cabeça ou o rosto de ninguém: a pessoa enquadrada deve aparecer inteira (cabeça com folga em cima,
  ombros e mãos). Se ela não couber, use "wide" em vez de aproximar. Aproximação forte (scale > 1.3) só para objetos
  ou quando a pessoa está pequena no quadro original.
- Se só há uma pessoa, varie entre scale 1 e aproximações leves nas frases de impacto.


Formato de saída: ${s.format}. Memes ${s.useMemes ? 'permitidos' : 'DESATIVADOS (overlays = [])'}. Efeitos sonoros ${s.useSfx ? 'permitidos' : 'DESATIVADOS (sfx = [])'}.

Biblioteca local disponível (categoria: arquivos):
${describeLibrary(args.library)}

Cortes (transcrição com tempos RELATIVOS ao início de cada corte):
${args.clips
  .map((c) => {
    const visual = args.visualByClip?.get(c.index);
    return `### clipIndex ${c.index} — "${c.title}" — duração ${c.duration.toFixed(1)}s\n${c.transcript}${visual ? `\nFrames deste corte (imagens anexadas):\n${visual}` : ''}`;
  })
  .join('\n\n')}

Retorne JSON exatamente neste formato:
{"clips":[{"clipIndex":0,
 "shots":[{"at":0,"duration":4.5,"type":"focus","focusX":0.28,"focusY":0.42,"scale":1,"reason":"A fala"},{"at":4.5,"duration":3,"type":"wide","reason":"os dois riem"},{"at":7.5,"duration":3,"type":"focus","focusX":0.55,"focusY":0.7,"scale":1.6,"reason":"close na comida"}],
 "zooms":[{"at":2.5,"duration":2,"scale":1.2,"focusX":0.5,"focusY":0.4}],
 "overlays":[{"type":"meme","category":"humor","file":"arquivo.png","at":8.1,"duration":1.5,"position":"top","scale":0.5}],
 "sfx":[{"category":"impacto","file":"boom.wav","at":8.1,"volume":0.8}],
 "emphasisWords":["palavra","chave"],
 "title":"título final do post (máx. 70 caracteres, gancho forte)",
 "description":"legenda do post: 1-3 frases que geram curiosidade + chamada para ação",
 "hashtags":["#tema","#nicho"]}]}
Escreva title, description e hashtags no idioma "${args.language}". Use de 5 a 10 hashtags relevantes ao conteúdo (misture amplas e de nicho).
Regras: "at" + "duration" dentro da duração do corte; type "meme" usa categorias de memes, "image" usa categorias de images;
sfx usa categorias de audio; position ∈ center|top|bottom|top-left|top-right; não cubra o rosto/centro com memes por muito tempo.`;
}

export function buildTranslationPrompt(items: { id: number; text: string }[], targetLang: string, sourceLang: string): string {
  return `Traduza as legendas de "${sourceLang}" para "${targetLang}". Mantenha o tom coloquial, gírias equivalentes e frases curtas.
Não junte nem divida itens. Retorne JSON: {"translations":[{"id":0,"text":"..."}]}

${JSON.stringify(items)}`;
}
