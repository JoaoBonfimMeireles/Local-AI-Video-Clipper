// Sessão "a partir de um corte viral": a IA estuda o corte de outra pessoa (o modelo do que funcionou) e monta
// versões PRÓPRIAS a partir do vídeo original — o mesmo momento com outra montagem e outras partes com a mesma pegada.
import { z } from 'zod';
import { ClipCandidateSchema } from './schemas';

const cappedText = (max: number, min = 0) => z.string().trim().min(min).transform((s) => s.slice(0, max));

export const AssetRequestSchema = z.object({
  at: z.coerce.number().finite().min(0).max(600),
  duration: z.coerce.number().finite().min(0.5).max(8).default(2),
  kind: z.enum(['image', 'meme', 'sound']).catch('image'),
  what: cappedText(160, 2),
  display: z.enum(['full', 'corner', 'top']).catch('corner'),
  reason: cappedText(200).default(''),
});

export const RecreateClipSchema = z.intersection(
  ClipCandidateSchema,
  z.object({
    /** "variação" (mesmo momento do corte de referência) ou "novo" (outra parte do vídeo, mesma pegada). */
    kind: z.enum(['variation', 'new']).catch('variation'),
    /** O que esta versão faz de diferente (gancho, ordem, contexto...). */
    variant: cappedText(300).default(''),
    assets: z.array(AssetRequestSchema).max(8).default([]),
  }),
);

export const RecreatePlanSchema = z.object({
  /** A fórmula do corte de referência, em poucas linhas (gancho, estrutura, ritmo, por que funciona). */
  concept: cappedText(1500).default(''),
  clips: z.array(RecreateClipSchema).max(25),
});
export type RecreatePlan = z.infer<typeof RecreatePlanSchema>;

export const RECREATE_SYSTEM = `Você é um editor sênior de cortes virais (Shorts, Reels, TikTok). Recebe um CORTE VIRAL feito
por outra pessoa e o VÍDEO ORIGINAL de onde ele saiu. Sua tarefa: entender a fórmula do corte (qual é o gancho, em que ordem
as falas aparecem, o ritmo, onde está o pico, como termina, o que ele mostra na tela) e montar cortes NOVOS e PRÓPRIOS a
partir do original, seguindo a mesma ideia. Nunca copie a montagem: o resultado tem de parecer outro corte, de outro editor.

Regras de cada corte:
- Use SOMENTE tempos do vídeo original (transcrição com [início-fim] em segundos). Pode juntar até 4 trechos (segments),
  na ordem em que devem aparecer.
- Gancho nos primeiros 1-3s; contexto suficiente para quem nunca viu; termina logo depois do desfecho. Nunca corte uma
  frase ao meio.
- Faixa de ouro: "loop" (15-20s, a última frase se liga à primeira) ou "story" (20-40s, desfecho seco). Pode passar disso
  só se o contexto exigir.
- Título com menos de 50 caracteres, diferente do título que o corte de referência sugere.

Dois tipos de corte (campo "kind"):
- "variation": o MESMO momento do corte de referência, com montagem diferente. Cada variação muda pelo menos DUAS coisas:
  outro gancho (abrir pelo clímax, por outra frase forte, pela reação), outra ordem dos trechos, mais ou menos contexto
  antes/depois, outro ponto de saída, outro formato (loop × story). Variações não podem ser iguais entre si.
- "new": momentos de OUTRAS partes do original com a mesma pegada do corte de referência (mesmo tipo de humor, de
  polêmica, de reação). Só proponha o que for realmente bom; se não houver, devolva menos.

Em "variant", diga em uma frase o que a versão faz de diferente. Responda SOMENTE com JSON válido.`;

export function buildRecreatePrompt(args: {
  referenceText: string;
  referenceDuration: number;
  matchedText: string;
  originalText: string;
  originalWindow: { start: number; end: number };
  variations: number;
  otherParts: number;
  targetDuration: number;
  visualNotes?: string;
  /** Pede a lista de material (imagens, memes, sons) que o editor deve mandar. */
  askAssets: boolean;
}): string {
  const assets = args.askAssets
    ? `
MATERIAL: quando a fala cita um famoso, um lugar, um produto, uma marca, um filme ou algo que fica melhor MOSTRADO (ou quando o
corte de referência mostrou algo na tela), peça o material em "assets" — o editor vai buscar e mandar. Cada pedido:
{"at": segundos desde o início DESTE corte, "duration": 1-4, "kind": "image"|"meme"|"sound", "what": "o que exatamente (ex.:
foto do Neymar sorrindo, logo da Coca-Cola, som de plateia rindo)", "display": "full" (tela inteira) | "corner" (quadro no
canto) | "top" (por cima da câmera), "reason": "por que ali"}. No máximo 4 por corte, só onde reforça de verdade.`
    : `
Não peça material: "assets" sempre [] (este job é só de cortes, sem memes, imagens nem sons).`;
  return `CORTE VIRAL DE REFERÊNCIA (${args.referenceDuration.toFixed(0)}s, tempos do próprio corte):
${args.referenceText}

ONDE ESSE CORTE ESTÁ NO ORIGINAL (trechos encontrados pela comparação das falas, na ordem em que o corte os usa):
${args.matchedText || '(não foi possível localizar com certeza — encontre pelo conteúdo)'}
${args.visualNotes ? `\nFRAMES DO CORTE DE REFERÊNCIA (anexados, nesta ordem):\n${args.visualNotes}\n` : ''}
VÍDEO ORIGINAL (de ${args.originalWindow.start.toFixed(0)}s a ${args.originalWindow.end.toFixed(0)}s):
${args.originalText}

PEDIDO:
- ${args.variations} corte(s) "variation" do mesmo momento.
- ${args.otherParts ? `até ${args.otherParts} corte(s) "new" de outras partes do trecho acima, com a mesma pegada` : 'nenhum corte "new"'}.
- Duração de referência: ~${args.targetDuration}s.
${assets}

Formato: {"concept": "a fórmula do corte de referência em 3-6 linhas", "clips": [{"kind": "variation"|"new", "variant": "...",
"segments": [{"start": s, "end": s}], "shortFormat": "loop"|"story", "score": 0-100, "title": "...", "reason": "...",
"hook": "...", "assets": []}]}`;
}
