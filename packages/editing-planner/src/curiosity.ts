// Canal de curiosidades: a IA lê a transcrição do vídeo-fonte e monta ideias de vídeos curtos seguindo os
// formatos da biblioteca (gancho + roteiro de narração + CTA), cada uma apontando os trechos do vídeo a usar.
import { z } from 'zod';
import { CURIOSITY_TEMPLATES, type CuriosityTemplateKey, type Transcript } from '@clipper/shared';
import { compactTranscript } from './prompts';

const text = (max: number, min = 0) => z.string().trim().min(min).transform((s) => s.slice(0, max));

export const CuriosityIdeaListSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { ideas: v } : v),
  z.object({
    summary: text(600).default(''),
    ideas: z
      .array(
        z.object({
          template: z.string().trim(),
          title: text(120, 3),
          hook: text(200, 3),
          script: text(1200, 10),
          cta: text(200).default(''),
          segments: z
            .array(z.object({ start: z.coerce.number().min(0), end: z.coerce.number().min(0), label: text(60).nullish() }))
            .min(1)
            .max(8),
          score: z.coerce.number().finite().min(0).max(100).catch(70),
          reason: text(500).default(''),
          hashtags: z.array(z.string().trim().max(40)).max(12).default([]),
          spoiler: z.boolean().catch(false).default(false),
        }),
      )
      .max(30),
  }),
);
export type CuriosityIdeaList = z.infer<typeof CuriosityIdeaListSchema>;

export const CURIOSITY_SYSTEM = `Você é roteirista de um canal brasileiro de vídeos curtos de CURIOSIDADES (Shorts/TikTok/Reels).
Recebe a transcrição de um vídeo-fonte (documentário, aula, podcast, notícia) e transforma o conteúdo em vários vídeos curtos e independentes, todos no mesmo estilo do canal.

Regras:
- Cada ideia segue UM formato da lista dada, respeitando a estrutura dele (gancho, roteiro, CTA).
- Os fatos vêm do vídeo-fonte: não invente números ou nomes que não estejam na transcrição. Pode simplificar e reorganizar.
- segments: trechos do vídeo-fonte (em segundos, usando os tempos da transcrição) que servem de imagem para a narração, na ordem em que aparecem. Total de 20 a 45s por ideia (Top N pode ir até 60s, com um trecho por item e label com o nome do item). Comece e termine em frases inteiras.
- hook: a frase dos primeiros 2 segundos, curta e impossível de ignorar (máx. 12 palavras).
- script: a narração completa em português do Brasil, em tom de professor animado que conversa com o público: começa pelo gancho, desenvolve e termina com o CTA. Duração falada parecida com a dos trechos (≈ 2,5 palavras por segundo). Sem emojis, sem marcações de cena.
- cta: a chamada final (comentar, seguir, compartilhar), ligada ao assunto.
- title: título do post (máx. 80 caracteres), no estilo do canal.
- Ideias diferentes não devem repetir o mesmo fato; trechos podem se repetir entre ideias se fizer sentido.
- score: 0-100, o potencial de viralizar.
- reason: em uma frase, por que essa ideia funciona.
- hashtags: 4 a 8, sem espaços, com #.
- Filmes e séries: narração por cima de trechos CURTOS (até ~8s cada), com comentário próprio (resumo, explicação, opinião) — nunca reproduza cenas longas inteiras. Roteiro em partes (parte 1, 2, 3). spoiler: true quando revelar final ou reviravolta; nesse caso o roteiro começa com "Alerta de spoiler".

Responda SOMENTE com JSON:
{"summary":"do que trata o vídeo-fonte, em 1-2 frases","ideas":[{"template":"chave_do_formato","title":"...","hook":"...","script":"...","cta":"...","segments":[{"start":0,"end":0,"label":null}],"score":0,"reason":"...","hashtags":["#..."],"spoiler":false}]}`;

export function buildCuriosityPrompt(opts: { transcript: Transcript; templates: CuriosityTemplateKey[]; count: number; topic?: string; targetSeconds?: number; maxChars: number }): string {
  const formats = CURIOSITY_TEMPLATES.filter((t) => opts.templates.includes(t.key))
    .map((t) => `- ${t.key} — "${t.label}": ${t.desc}\n  gancho: ${t.hook}\n  roteiro: ${t.script}\n  CTA: ${t.cta}\n  exemplo: ${t.example}`)
    .join('\n');
  let body = compactTranscript(opts.transcript);
  if (body.length > opts.maxChars) body = body.slice(0, opts.maxChars) + '\n[...transcrição cortada por tamanho]';
  return `Formatos disponíveis (use as chaves exatas em "template"; distribua as ideias entre eles):
${formats}

Gere ${opts.count} ideias.${opts.targetSeconds ? `
DURAÇÃO ALVO: cada vídeo com ~${opts.targetSeconds}s (trechos somando ${opts.targetSeconds - 5} a ${opts.targetSeconds}s; narração com no máximo ${Math.round(opts.targetSeconds * 2.5)} palavras). Vídeos diretos, sem enrolação.` : ''}${opts.topic?.trim() ? `\nFoco pedido pelo editor: ${opts.topic.trim()}` : ''}
Duração do vídeo-fonte: ${opts.transcript.duration.toFixed(0)}s.

Transcrição [início-fim em segundos]:
${body}`;
}
