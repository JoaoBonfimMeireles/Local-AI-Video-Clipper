import type { Intensity, JobSettings, LibraryIndex, Transcript } from '@clipper/shared';
import type { VideoKnowledge } from './schemas';
import { formatTimestamp } from '@clipper/shared';

export const SELECTION_SYSTEM = `Você é um editor sênior de vídeos virais (TikTok, Reels, Shorts).
Sua tarefa é encontrar os trechos de um vídeo longo com maior potencial de retenção e compartilhamento.
O que faz um corte viralizar é RETENÇÃO: a pessoa assiste até o fim e reassiste. Para isso cada corte precisa de:
1) GANCHO nos primeiros 1-3s (a frase/imagem mais intrigante, uma pergunta, o começo do absurdo);
2) CONTEXTO suficiente para quem nunca viu o vídeo entender O QUE está acontecendo e POR QUE aquilo chegou ali (o que
   levou à piada, à briga, ao comentário) — um corte que parece "o meio de uma conversa" é um corte ruim;
3) DESFECHO: a reação, a punchline, a conclusão. Termine logo depois do desfecho, nunca antes.
Nunca corte uma frase ou ideia ao meio ("mas, aí..." e acaba). Seja crítico: qualidade importa mais que quantidade.

FAIXA DE OURO DOS SHORTS (métrica nº 1: retenção + "escolheram assistir vs. pularam"; o corte não vende nada nem pede inscrição):
- O corte COMEÇA na palavra mais forte, chocante, curiosa ou polêmica da fala. Nada de saudação, "a gente estava
  conversando sobre...", apresentação ou enrolação antes do gancho.
- Escolha UM de dois formatos para cada corte (campo "shortFormat"):
  • "loop" (15-20s) — pílula rápida: gancho (0-3s) → resposta/entrega em 2-3 frases curtas (3-14s) → fechamento
    (15-20s) cuja última frase se conecta com a primeira, para o vídeo rodar em loop sem a pessoa perceber onde recomeça.
  • "story" (20-40s) — gancho de curiosidade (0-4s: o problema ou o resultado inacreditável logo de cara) → conflito/
    contexto acelerado (4-18s) → clímax/virada (18-32s) → DESFECHO SECO (32-40s): termina logo após o ponto alto,
    sem "se inscreva", sem despedida, abrupto.
- Pode juntar trechos distantes para montar o gancho (abrir com a frase forte e depois mostrar o contexto).
Responda SOMENTE com JSON válido, sem comentários.`;

/** Formatos de shorts que costumam performar bem — a IA usa como repertório, não como lista obrigatória. */
export const VIRAL_FORMATS = `Repertório de formatos que funcionam em shorts (use qualquer um que caiba no material, ou outro que você reconheça):
- contexto → reação: mostra rápido o que aconteceu e depois a reação exagerada/genuína
- storytime: a pessoa conta uma história com começo, virada e final engraçado/chocante
- pergunta/comentário do chat → resposta absurda ou certeira
- fail/vexame e "deu ruim": o plano que dá errado, com a consequência
- treta/discussão/roast: provocação, resposta, quem venceu
- plot twist: começa de um jeito e termina de outro inesperado
- frase que vira meme / fala fora de contexto (curta, mas compreensível)
- raiva/rage, desespero, susto genuíno
- momento wholesome/emocionante
- opinião forte ou polêmica com argumento completo
- imitação, personagem, bordão, piada interna explicada
- jogada absurda, clutch, conquista, recorde`;

/** Regras de quantidade e qualidade (o vídeo decide quantos cortes, não uma meta). */
const QUALITY_QTY = `Quantidade: VOCÊ decide pelo material. Inclua só momentos que realmente seguram alguém até o fim (nota >= 70).
Vídeo curto ou fraco → poucos cortes (1, 2 ou 3 está ótimo); vídeo longo e rico → quantos tiverem qualidade (podem ser dezenas).
Nunca invente corte para "completar número". Notas realistas: 90+ só para o que você postaria com certeza.`;

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

export const ANALYSIS_SYSTEM_TWITCH = `Você é um espectador veterano de lives da Twitch e editor de clipes. Pela transcrição e pelos
frames, entenda a live como quem assiste: o jogo ou a situação, quem participa (streamer, convidados, call, chat lido
em voz alta), as piadas internas, os sustos, as zoeiras e as interações com viewers. Mapeie os momentos que renderiam
clipes. Esta análise será guardada e reutilizada para cortes diferentes: seja completo e preciso nos tempos.
Escreva as descrições em português. Responda SOMENTE com JSON válido, sem comentários.`;

const SILENT_RULE = (gaps?: string) =>
  gaps
    ? `Trechos SEM FALA (a ação acontece só na imagem — olhe as imagens desses tempos e descreva o que a pessoa FAZ): ${gaps}
Muitas vezes a reação falada ("que isso!", "nossa, Fulana!") vem DEPOIS de uma ação silenciosa: registre a ação como
parte do mesmo momento (o momento começa quando a ação começa, não quando alguém fala).\n`
    : '';

export function buildAnalysisPrompt(args: { transcriptText: string; videoDuration: number; visualNotes?: string; chunkInfo?: string; mode?: 'youtube' | 'twitch'; audioPeaks?: string; activeWindows?: string; silentGaps?: string }): string {
  if (args.mode === 'twitch') return buildTwitchAnalysisPrompt(args);
  return `Vídeo com duração total de ${formatTimestamp(args.videoDuration)} (${args.videoDuration.toFixed(0)}s).
${args.chunkInfo ?? ''}
${args.visualNotes ? `Frames amostrados (as imagens anexadas seguem esta ordem):\n${args.visualNotes}\n` : ''}${SILENT_RULE(args.silentGaps)}
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

function buildTwitchAnalysisPrompt(args: { transcriptText: string; videoDuration: number; visualNotes?: string; chunkInfo?: string; audioPeaks?: string; activeWindows?: string; silentGaps?: string }): string {
  const minMoments = Math.max(12, Math.round(args.videoDuration / 30));
  return `Live (VOD) com duração total de ${formatTimestamp(args.videoDuration)} (${args.videoDuration.toFixed(0)}s).
${args.chunkInfo ?? ''}
${args.visualNotes ? `Frames amostrados (as imagens anexadas seguem esta ordem):\n${args.visualNotes}\n` : ''}
${SILENT_RULE(args.silentGaps)}${args.audioPeaks ? `Picos de volume no áudio (gritos, risadas, sustos, euforia — ótimos candidatos a clipe): ${args.audioPeaks}\n` : ''}${args.activeWindows ? `Trechos mais agitados (muita ação na tela + áudio alto): ${args.activeWindows}\n` : ''}
Transcrição com timestamps (segundos absolutos):
${args.transcriptText}

Retorne JSON neste formato:
{"summary":"o que rolou na live em 3-6 frases (jogo, convidados, clima)",
 "format":"ex.: gameplay de terror com facecam no canto inferior direito; IRL na rua; react; call com amigos",
 "speakers":[{"id":"S","description":"streamer, homem de headset","position":"facecam no canto inferior direito (x≈0.85, y≈0.8)"}],
 "topics":["assunto 1","assunto 2"],
 "moments":[{"start":812.3,"end":826.0,"type":"funny|scary|chat|roast|quote|highlight|story|other",
   "topic":"assunto curto (ex.: banana, chefe final, donate do fulano)",
   "description":"o que acontece e por que é bom","quote":"frase literal curta","speaker":"S","strength":90,
   "visual":"o que aparece (ex.: jumpscare, streamer cai da cadeira, tela de game over)"}]}
Regras: moments deve cobrir a live INTEIRA com pelo menos ${minMoments} momentos (≈1 a cada 30s; blocos de 3 a 40s, sem
lacunas grandes) — momentos fracos também entram, com strength baixo; olhe com atenção os picos de volume; use "topic" igual para trechos
sobre o mesmo assunto mesmo que separados no tempo (assim dá para juntar "banana" ignorando o desvio para "maçã");
strength (0-100) = quanto esse momento renderia um clipe; chat = streamer lendo/respondendo viewer, donate, raid;
roast = alguém zoando outra pessoa; scary = susto/tensão; highlight = jogada, clutch, fail épico.`;
}

export function knowledgeToText(k: VideoKnowledge): string {
  const speakers = k.speakers.map((p) => `  - ${p.id}: ${p.description}${p.position ? ` — ${p.position}` : ''}`).join('\n');
  const moments = k.moments
    .map(
      (m) =>
        `[${m.start.toFixed(1)}-${m.end.toFixed(1)}] (${m.type}${m.topic ? `, assunto: ${m.topic}` : ''}, força ${Math.round(m.strength)}${m.speaker ? `, fala ${m.speaker}` : ''}) ${m.description}${m.quote ? ` — "${m.quote}"` : ''}${m.visual ? ` [visual: ${m.visual}]` : ''}`,
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

const TWITCH_CATEGORY_RULES: Record<string, string> = {
  funny: 'funny — os momentos MAIS engraçados (risada genuína, situação absurda, piada que funcionou)',
  scary: 'scary — sustos e tensão (jumpscare, grito, momento de pânico, quase morte no jogo)',
  top5: 'top5 — no máximo UM corte compilação "Top melhores momentos": de 3 a 5 trechos (só os que forem MUITO bons; se não houver 3 bons, NÃO faça), em contagem regressiva (o melhor por último). Cada trecho de 8-22s precisa ser compreensível sozinho: inclua o que levou ao momento e o desfecho, frases completas. Cada trecho TEM "label": título curto do momento (máx. 30 caracteres), que aparece na tela ao lado do número',
  reaction: 'reaction — o streamer reagindo a algo que VIU (no jogo, no chat, num vídeo, um fail de outro jogador) e achou engraçado/absurdo',
  chat: 'chat — interação com viewers (lendo/respondendo o chat de forma engraçada, donate, raid, pedido inusitado)',
  roast: 'roast — uma pessoa zoando a outra, provocações, alguém sendo humilhado de forma engraçada',
  quotes: 'quotes — falas marcantes isoladas (frase engraçada, polêmica, sem contexto que vira meme)',
  highlights: 'highlights — jogadas: clutch, fail épico, momento de skill, final de partida',
};

function buildTwitchSelectionPrompt(args: { knowledge: VideoKnowledge; settings: JobSettings; videoDuration: number; transcriptText?: string }): string {
  const { settings: s } = args;
  const cats = (s.twitchCategories.length ? s.twitchCategories : Object.keys(TWITCH_CATEGORY_RULES)).map((c) => `- ${TWITCH_CATEGORY_RULES[c]}`).join('\n');
  const qty =
    s.maxClips === 'auto'
      ? QUALITY_QTY
      : `Quantidade: até ${s.maxClips} cortes no total, só os de qualidade.`;
  return `Duração total da live: ${args.videoDuration.toFixed(0)}s.
Formato do corte: "loop" 15-20s ou "story" 20-40s (duração alvo ~${s.targetDuration}s). Passe de 40s SÓ se for indispensável para a
história fazer sentido — corte o meio (pausas, repetições, desvios) em vez de alongar.
${qty}

Categorias (cada corte pertence a UMA; o ângulo do corte pode ser qualquer formato do repertório abaixo):
${cats}

${VIRAL_FORMATS}

Análise da live:
${knowledgeToText(args.knowledge)}
${args.transcriptText ? `
Transcrição completa (use para achar onde cada ideia COMEÇA e TERMINA de verdade):
${args.transcriptText}
` : ''}
Como um editor de clipes de Twitch:
- Cada corte tem de 1 a 8 trechos ("segments"), na ordem de exibição. Se uma história foi interrompida por outro assunto
  e depois retomada (banana → maçã → banana), monte o corte só com os trechos do assunto principal, pulando o desvio.
- Corte o tempo morto: silêncio, carregamento, o streamer lendo algo irrelevante. Comece no segundo que a coisa acontece
  (ou 2-4s antes, para dar contexto do susto/piada) e termine logo após a reação.
- O corte precisa funcionar para quem não viu a live: comece onde a situação COMEÇA (o que levou àquilo: a pergunta,
  o comentário do chat, o vídeo que ele está reagindo, a provocação) — não no meio. Se o contexto está longe, junte um
  trecho curto que explica antes do momento.
- NUNCA termine no meio de um raciocínio, piada ou história: se a pessoa ainda está concluindo, estenda o corte até
  o desfecho (pode passar bem da duração desejada). Começo e fim em frases completas, nunca numa palavra solta.
- React (streamer assistindo vídeo): o corte precisa mostrar o que ele viu (o trecho do vídeo) E a reação dele.
  Quando ele COMENTA algo do vídeo ("esqueceu a sopa na panela de pressão...", "olha o que ele fez"), o corte começa
  ANTES, no trecho do vídeo assistido que mostra/explica aquilo (a pessoa do vídeo contando a situação, a cena da
  panela) — quem assiste o short precisa entender do que ele está falando antes de ouvir o comentário. Começo
  (o que estava passando), meio (o que aconteceu) e fim (a reação/piada dele).
- AÇÃO SEM FALA: se a reação ("nossa, Catalina!", "que isso?!") vem depois de algo que só aparece na imagem (alguém
  jogando sal, caindo, fazendo algo absurdo), o trecho TEM de começar antes, quando a ação começa — mesmo que nesses
  segundos ninguém fale (veja os buracos de tempo na transcrição e o "visual" dos momentos). Sem a ação, a reação não faz sentido.
- Pense como editor de clipes: prefira os trechos mais agitados (picos de volume, muita ação), o comentário certeiro,
  a sacada, a zoeira com o chat. Um "corte simples" de 10-20s com uma fala ótima também vale.

Retorne JSON exatamente neste formato:
{"clips":[{"category":"funny","shortFormat":"story","segments":[{"start":812.3,"end":826.0},{"start":1490.2,"end":1502.8}],"score":88,"title":"título curto estilo clipe","reason":"por que é bom (e o que foi pulado, se pulou)","hook":"primeira fala"},
 {"category":"top5","segments":[{"start":300.1,"end":311.0,"label":"O PC travou de novo"},{"start":901.2,"end":913.4,"label":"Neymar na call"}],"score":95,"title":"TOP 5 momentos da live","reason":"...","hook":"..."}]}
Regras: tempos alinhados ao início/fim de frases (use os tempos dos momentos); cortes não repetem trechos entre si
(exceto o top5, que pode reaproveitar os melhores momentos); score de 0 a 100.`;
}

export function buildSelectionFromKnowledgePrompt(args: { knowledge: VideoKnowledge; settings: JobSettings; videoDuration: number; transcriptText?: string }): string {
  if (args.settings.mode === 'twitch') return buildTwitchSelectionPrompt(args);
  const { settings: s } = args;
  const qty =
    s.maxClips === 'auto'
      ? QUALITY_QTY
      : `Quantidade: proponha até ${Math.min(60, (s.maxClips as number) * 2)} candidatos (serão escolhidos os ${s.maxClips} melhores).`;
  return `Duração total do vídeo: ${args.videoDuration.toFixed(0)}s.
Formato do corte: "loop" 15-20s ou "story" 20-40s (duração alvo ~${s.targetDuration}s). Passe de 40s SÓ se for indispensável para a
história fazer sentido — corte o meio (pausas, repetições, desvios) em vez de alongar.
${qty}

${VIRAL_FORMATS}

Análise do vídeo:
${knowledgeToText(args.knowledge)}
${args.transcriptText ? `
Transcrição completa (use para achar onde cada ideia COMEÇA e TERMINA de verdade):
${args.transcriptText}
` : ''}
Monte cada corte com 1 a 4 trechos ("segments"), na ordem em que devem aparecer. Você PODE juntar trechos distantes
quando isso deixar o corte mais forte (ex.: abrir com a conclusão/frase de impacto do final e depois mostrar o contexto
do início; ou juntar falas boas espalhadas sobre o mesmo assunto). Cada corte precisa fazer sentido sozinho para quem
nunca viu o vídeo: gancho nos primeiros 3s, começo-meio-fim, sem depender de contexto ausente.

Retorne JSON exatamente neste formato:
{"clips":[{"shortFormat":"loop","segments":[{"start":120.4,"end":131.0},{"start":12.3,"end":55.8}],"score":87,"title":"título curto e chamativo","reason":"por que funciona (e por que juntou os trechos, se juntou)","hook":"frase de abertura"}]}
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
      ? QUALITY_QTY
      : `Quantidade: proponha até ${Math.min(60, (s.maxClips as number) * 2)} candidatos (serão escolhidos os ${s.maxClips} melhores).`;
  return `Vídeo com duração total de ${formatTimestamp(args.videoDuration)} (${args.videoDuration.toFixed(0)}s).
${args.chunkInfo ?? ''}
Duração média desejada por corte: ~${s.targetDuration}s (referência flexível: entre ${Math.round(s.targetDuration * 0.6)}s e ${Math.round(s.targetDuration * 1.5)}s).
${qty}

${VIRAL_FORMATS}
${args.visualNotes ? `\nContexto visual (frames amostrados):\n${args.visualNotes}\n` : ''}
Transcrição com timestamps (segundos absolutos):
${args.transcriptText}

Retorne JSON exatamente neste formato:
{"clips":[{"start":12.3,"end":71.8,"score":87,"title":"título curto e chamativo","reason":"por que este trecho viraliza","hook":"frase de abertura"}]}
Regras: start/end devem coincidir com início/fim de frases da transcrição; cortes não podem se sobrepor; score de 0 a 100.`;
}

const TWITCH_EDIT_RULES = `ESTILO CLIPE DE TWITCH / SHORTS (siga à risca):
- Memes entram LOGO DEPOIS da piada, do susto ou da zoeira (0,2-0,8s após), nunca antes de entregar o momento.
- Memes em vídeo: use a duração do próprio arquivo (até ~5s). Os de "fundo verde" ficam recortados por cima do vídeo:
  use position center ou bottom e scale 0.6-0.9. Se o meme "com áudio" tocar, NÃO coloque efeito sonoro ao mesmo tempo.
- Efeitos sonoros (estilo myinstants) pontuam reações: susto → impacto/grito, fail → som de erro/"bruh", piada → risada.
- Varie: não repita o mesmo meme no mesmo corte. Em momentos sérios ou de tensão real, sem memes de humor.
- Palavras em destaque: nomes, xingamentos leves, números, gírias da live.

`;

const MEME_RULES = `MEMES E SONS — VALIDE ANTES DE USAR:
- Entenda cada meme/som pelo NOME (é a única descrição). Só use se o nome combinar claramente com o que acontece
  naquele instante (a emoção, a fala, a ação). Na dúvida, NÃO use: um corte sem meme é melhor que um meme sem sentido.
- Escreva em "reason" por que combina. Se não conseguir justificar em uma frase, descarte e escolha outro (ou nenhum).
- Ignore nomes que não dizem nada (só números, códigos) ou cujo assunto não tem relação com o vídeo.
- Memes "com áudio": decida "audioMode" pensando no que fica melhor NAQUELE momento:
  "meme" = só o som do meme (a fala do vídeo silencia nesse trecho) — quando o meme é a piada e ninguém está falando
  algo importante; "video" = meme mudo, fica a fala — quando a fala não pode ser perdida; "both" = os dois, com o vídeo
  mais baixo — quando o som do meme é curto/de fundo e a fala continua relevante.
- Não coloque efeito sonoro em cima de um meme com áudio em modo "meme" ou "both" (fica embolado).
- Não repita o mesmo meme ou som no mesmo corte.

`;

const ILLUSTRATION_RULES = `ILUSTRAÇÕES ("illustrations") — imagem do que está sendo falado, para o espectador visualizar:
- Só para coisas CONCRETAS e reconhecíveis citadas na fala: objeto (avião, moto), animal, lugar, comida, marca,
  pessoa famosa, filme, série, jogo. Nunca para ideias abstratas, sentimentos ou para o próprio streamer/convidados.
- "at" = o instante em que a palavra é dita (use os tempos da transcrição); duração 1,5-3s.
- "query": o nome em INGLÊS como seria o título do artigo na Wikipedia: substantivo simples para coisas ("Airplane",
  "Pizza", "Lion"), nome completo para pessoas ("Neymar"), título oficial para filme/série/jogo ("Interstellar",
  "Grand Theft Auto V"). Sem adjetivos nem frases. "label": o nome em português.
- "kind" ∈ object|animal|place|person|brand|movie|series|game|food|other.
- "position": top (padrão), top-left ou top-right — nunca em cima do rosto; não use no mesmo instante de um meme.
- Na dúvida, não ilustre: no máximo 1 a cada ~10s, só quando a imagem ajuda a entender ou deixa o corte mais bonito.

`;

const INTENSITY_RULES: Record<Intensity, string> = {
  low: 'Intensidade BAIXA: cortes limpos. No máximo 1 zoom suave (scale 1.1) por corte, nenhum meme, no máximo 1 efeito sonoro.',
  medium:
    'Intensidade MÉDIA (ritmo de Shorts): mude o enquadramento a cada 2,5-3s (alternando zoom in/out, scale 1.1-1.25, ou trocando quem está em quadro) para manter o cérebro ativo; som de "whoosh"/"pop" nas trocas de cena e emendas; memes só em picos de humor/surpresa (máx. 2 por corte).',
  high:
    'Intensidade ALTA: ritmo acelerado. Troque o enquadramento a cada 2-4s (alternando scale 1.12-1.4 e focusX/focusY); muitos memes de reação (até 5 por minuto); efeitos sonoros frequentes (impacto, risadas, transições — até 10 por minuto).',
};

/** Metadados de um asset da biblioteca, chave "memes/categoria/arquivo". */
export type AssetMeta = Record<string, { duration: number; hasAudio: boolean; greenScreen: boolean }>;

export function describeLibrary(lib: LibraryIndex, maxFiles = 25, meta?: AssetMeta): string {
  const label = (kind: string, cat: string, f: string) => {
    const m = meta?.[`${kind}/${cat}/${f}`];
    if (!m || !m.duration) return f;
    const tags = [`${m.duration.toFixed(1)}s`, m.hasAudio ? 'com áudio' : '', m.greenScreen ? 'fundo verde' : ''].filter(Boolean).join(', ');
    return `${f} (${tags})`;
  };
  const fmt = (kind: string, cats: LibraryIndex['memes']) =>
    cats.length
      ? cats.map((c) => `  - ${kind}/${c.name}: ${c.files.slice(0, maxFiles).map((f) => label(kind, c.name, f)).join(', ') || '(vazia)'}`).join('\n')
      : `  - ${kind}: (nenhum arquivo)`;
  return [fmt('memes', lib.memes), fmt('audio', lib.audio)].join('\n');
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
  /** Duração/áudio/fundo verde dos memes e sons. */
  assetMeta?: AssetMeta;
  /** Layout facecam + jogo (modo Twitch): enquadramento é fixo, sem shots. */
  splitLayout?: boolean;
  /** Catálogo pré-selecionado com códigos curtos (m1, s1...) — substitui a listagem por pasta. */
  catalog?: string;
  /** Pede ilustrações (imagens buscadas na internet) do que é falado. */
  illustrations?: boolean;
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

${s.mode === 'twitch' ? TWITCH_EDIT_RULES : ''}${args.splitLayout ? 'Layout fixo facecam (em cima) + jogo (embaixo): retorne "shots": [] e zooms leves (scale <= 1.12).\n' : ''}
${MEME_RULES}
${args.illustrations ? ILLUSTRATION_RULES : ''}${args.catalog ? `Biblioteca (pré-selecionada para estes cortes; use os CÓDIGOS em "file"):\n${args.catalog}` : `Biblioteca local disponível (categoria: arquivos):\n${describeLibrary(args.library, 25, args.assetMeta)}`}

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
 "overlays":[{"type":"meme","file":"m12","at":8.1,"duration":2.5,"position":"center","scale":0.7,"audioMode":"meme","reason":"ele leva um susto e o meme é um gato assustado gritando"}],
 "sfx":[{"file":"s3","at":8.1,"volume":0.8,"reason":"impacto no susto"}],${
   args.illustrations
     ? `
 "illustrations":[{"at":3.2,"duration":2.5,"query":"commercial airplane","label":"avião","kind":"object","position":"top","reason":"ele fala do avião"}],`
     : ''
 }
 "emphasisWords":["palavra","chave"],
 "title":"título final do post (MENOS de 50 caracteres, altamente clicável, gancho forte)",
 "coverText":"texto curto para a capa do Short (3-6 palavras, impacto)",
 "description":"legenda do post: 1-3 frases que geram curiosidade + chamada para ação",
 "hashtags":["#tema","#nicho"]}]}
Escreva title, description e hashtags no idioma "${args.language}". Use de 5 a 10 hashtags relevantes ao conteúdo (misture amplas e de nicho).
Regras: "at" + "duration" dentro da duração do corte; overlays só com MEMES (type "meme", sem imagens estáticas);
sfx podem ter "duration" (quanto do som tocar, padrão 5s);
sfx usa categorias de audio; position ∈ center|top|bottom|top-left|top-right; não cubra o rosto/centro com memes por muito tempo.`;
}

export function buildTranslationPrompt(items: { id: number; text: string }[], targetLang: string, sourceLang: string): string {
  return `Traduza as legendas de "${sourceLang}" para "${targetLang}". Mantenha o tom coloquial, gírias equivalentes e frases curtas.
Não junte nem divida itens. Retorne JSON: {"translations":[{"id":0,"text":"..."}]}

${JSON.stringify(items)}`;
}

export const REVISION_SYSTEM = `Você é o editor que fez este corte e recebeu um pedido de ajuste. Aplique EXATAMENTE o que foi
pedido e mantenha todo o resto igual (mesmos memes, sons, zooms e textos que não foram citados). Use somente arquivos do
catálogo (códigos m.., s..) ou os que já estavam no plano. Responda SOMENTE com JSON válido, sem comentários.`;

export function buildRevisionPrompt(args: {
  comment: string;
  currentPlan: unknown;
  segments: { start: number; end: number; label?: string | null }[];
  duration: number;
  transcript: string;
  catalog: string;
  language: string;
}): string {
  return `PEDIDO DO EDITOR (prioridade máxima):
"""
${args.comment.slice(0, 2000)}
"""

Corte atual: ${args.duration.toFixed(1)}s, montado com estes trechos do vídeo original (tempos absolutos):
${JSON.stringify(args.segments)}

Transcrição do corte (tempos RELATIVOS ao início do corte):
${args.transcript}

Plano atual (tempos relativos; "file" são nomes de arquivo — pode mantê-los):
${JSON.stringify(args.currentPlan)}

Catálogo disponível (pré-selecionado para este corte; use os CÓDIGOS em "file" para trocar/adicionar):
${args.catalog}

Retorne o plano COMPLETO revisado neste formato (mesmo do plano atual):
{"segments":null,"shots":[...],"zooms":[...],"overlays":[{"type":"meme","file":"m3","at":4.2,"duration":2,"position":"center","scale":0.7,"audioMode":"both","reason":"..."}],
 "sfx":[{"file":"s2","at":4.2,"volume":0.8,"reason":"..."}],"emphasisWords":[...],"title":"...","description":"...","hashtags":[...],
 "changes":"o que você mudou"}
Regras: só preencha "segments" (tempos ABSOLUTOS do vídeo original) se o pedido mudar começo, fim ou trechos do corte
(ex.: "começa 5s antes" → start do primeiro trecho - 5); senão use null. Se mudar os trechos, ajuste os tempos dos
memes/sons para a nova linha do tempo. Textos (title/description/hashtags) no idioma "${args.language}".`;
}

export const REFERENCE_SYSTEM = `Você é um editor de clipes virais estudando um corte de sucesso para copiar a FÓRMULA (não o
conteúdo). Pela transcrição, pelas métricas de ritmo e pelos frames, explique como o clipe prende a atenção.
Seja concreto e prático (tempos, quantidades, exemplos). Escreva em português. Responda SOMENTE com JSON válido.`;

export function buildReferencePrompt(args: { name: string; transcript: string; stats: string; visualNotes?: string }): string {
  return `Clipe de referência: "${args.name}"
Métricas medidas: ${args.stats}
${args.visualNotes ? `Frames (imagens anexadas nesta ordem):\n${args.visualNotes}\n` : ''}
Transcrição (tempos em segundos):
${args.transcript || '(sem fala)'}

Retorne JSON:
{"niche":"ex.: clipe de live de GTA RP com facecam",
 "hook":"como os primeiros 1-3s prendem (frase, ação, texto na tela)",
 "structure":"sequência do clipe: contexto → tensão → clímax/piada → reação; onde fica o momento principal",
 "pacing":"ritmo: duração, cortes por minuto, cortes secos de pausas, velocidade",
 "humor":"tipo de humor/emoção e o que torna engraçado",
 "editing":"zooms, memes, sons, texto na tela, enquadramento (facecam/jogo), quando entram",
 "captions":"estilo das legendas (tamanho, palavras por vez, destaque)",
 "ending":"como termina (corte seco na reação, punchline, loop...)",
 "tips":["regra prática 1 para reproduzir este estilo", "..."]}`;
}

export function buildStyleGuidePrompt(styles: { name: string; style: unknown }[]): string {
  return `Abaixo estão análises de ${styles.length} clipe(s) viral(is) de referência. Junte o que é COMUM e mais eficaz em um
GUIA DE ESTILO único, curto e prático (no máximo ~350 palavras, em tópicos), para orientar outro editor a escolher
momentos e editar clipes no mesmo estilo. Inclua: tipos de momento que viralizam, gancho, estrutura, duração ideal,
ritmo/cortes, uso de memes/sons/zoom, legendas e final. Não cite nomes de canais.

${styles.map((s, i) => `### Referência ${i + 1}: ${s.name}\n${JSON.stringify(s.style)}`).join('\n\n')}

Retorne JSON: {"guide":"texto do guia em tópicos"}`;
}
