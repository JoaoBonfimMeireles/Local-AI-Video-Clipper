// Canal de curiosidades: biblioteca de formatos de vídeo e o tipo de uma ideia gerada (ou montada à mão).
// Este arquivo não pode importar módulos Node (é usado pela UI).

export type CuriosityTemplateKey =
  | 'top_n' | 'voce_sabia' | 'mito_verdade' | 'antes_depois' | 'e_se' | 'escala' | 'por_que' | 'segredo'
  | 'resumo_30' | 'resumo_filme' | 'ninguem_entendeu' | 'final_explicado' | 'cena_chave' | 'vale_a_pena';

export interface CuriosityTemplate {
  key: CuriosityTemplateKey;
  /** curiosidade: canal de fatos; filme: narrador resumindo/explicando filmes e séries. */
  group: 'curiosidade' | 'filme';
  label: string;
  emoji: string;
  /** Cores do card (gradiente) e do título no vídeo. */
  from: string;
  to: string;
  desc: string;
  /** Estrutura que a IA segue: gancho (0-3s), roteiro (o miolo) e chamada final. */
  hook: string;
  script: string;
  cta: string;
  /** Exemplo de título, para inspirar. */
  example: string;
}

export const CURIOSITY_TEMPLATES: CuriosityTemplate[] = [
  {
    key: 'top_n',
    group: 'curiosidade',
    label: 'Top N',
    emoji: '🏆',
    from: '#f59e0b',
    to: '#ef4444',
    desc: 'Lista numerada em contagem regressiva, o mais impressionante por último',
    hook: 'Número + promessa: "5 vulcões que podem entrar em erupção a qualquer momento"',
    script: 'Itens curtos (um trecho do vídeo por item), do 5 ao 1, cada um com um fato concreto',
    cta: '"Qual deles te assustou mais? Comenta o número"',
    example: '5 vulcões que podem acordar a qualquer momento',
  },
  {
    key: 'voce_sabia',
    group: 'curiosidade',
    label: 'Você sabia que...',
    emoji: '💡',
    from: '#22d3ee',
    to: '#6366f1',
    desc: 'Um fato surpreendente, explicado rápido e com uma virada no final',
    hook: '"Você sabia que..." + o fato mais estranho logo de cara',
    script: 'Contexto em 1 frase, o porquê em 2-3 frases, um detalhe extra que surpreende',
    cta: '"Segue para mais um fato desses amanhã"',
    example: 'Você sabia que existe um lago que transforma animais em pedra?',
  },
  {
    key: 'mito_verdade',
    group: 'curiosidade',
    label: 'Mito vs verdade',
    emoji: '⚖️',
    from: '#a855f7',
    to: '#ec4899',
    desc: 'Uma crença popular desmontada (ou confirmada) com provas',
    hook: 'A crença em forma de pergunta: "Raio nunca cai duas vezes no mesmo lugar?"',
    script: 'O que todo mundo acha → MITO ou VERDADE → a explicação de verdade',
    cta: '"Você acreditava nisso? Responde sim ou não"',
    example: 'Mito ou verdade: avestruz enterra a cabeça na areia?',
  },
  {
    key: 'antes_depois',
    group: 'curiosidade',
    label: 'Antes e depois',
    emoji: '⏳',
    from: '#10b981',
    to: '#0ea5e9',
    desc: 'Como algo era e como ficou: transformação, evolução, passagem do tempo',
    hook: 'O contraste em uma frase: "Esse lugar era um deserto há 50 anos"',
    script: 'Como era → o que aconteceu → como é hoje, com números',
    cta: '"Como você acha que vai estar daqui a 50 anos?"',
    example: 'Como era Dubai antes do petróleo',
  },
  {
    key: 'e_se',
    group: 'curiosidade',
    label: 'O que aconteceria se...',
    emoji: '🌀',
    from: '#f43f5e',
    to: '#8b5cf6',
    desc: 'Um cenário hipotético levado às últimas consequências',
    hook: '"O que aconteceria se..." + cenário absurdo mas plausível',
    script: 'Primeiro segundo → primeiro dia → longo prazo, cada etapa mais intensa',
    cta: '"Qual cenário você quer ver no próximo?"',
    example: 'O que aconteceria se a Lua sumisse hoje?',
  },
  {
    key: 'escala',
    group: 'curiosidade',
    label: 'Comparação de escala',
    emoji: '📏',
    from: '#0ea5e9',
    to: '#14b8a6',
    desc: 'Tamanhos, distâncias ou números comparados com algo do dia a dia',
    hook: 'O número absurdo: "Esse animal é maior que 3 ônibus enfileirados"',
    script: 'Do menor para o maior, sempre comparando com algo conhecido',
    cta: '"Marca alguém que precisa ver isso"',
    example: 'O tamanho real do maior navio do mundo',
  },
  {
    key: 'por_que',
    group: 'curiosidade',
    label: 'Por que...?',
    emoji: '❓',
    from: '#eab308',
    to: '#84cc16',
    desc: 'Responde uma dúvida que todo mundo já teve e ninguém sabe explicar',
    hook: 'A pergunta direta: "Por que o céu é azul e não roxo?"',
    script: 'A resposta curta primeiro, depois o mecanismo em passos simples',
    cta: '"Manda nos comentários a próxima pergunta"',
    example: 'Por que o mar é salgado e os rios não?',
  },
  {
    key: 'segredo',
    group: 'curiosidade',
    label: 'Ninguém te contou',
    emoji: '🤫',
    from: '#64748b',
    to: '#f97316',
    desc: 'Bastidores, detalhes escondidos ou algo que passa despercebido',
    hook: '"Quase ninguém percebe isso em..."',
    script: 'Mostra o detalhe → explica por que ele existe → consequência inesperada',
    cta: '"Agora você nunca mais vai ver isso do mesmo jeito"',
    example: 'O detalhe escondido em toda nota de dinheiro',
  },
  // Filmes e séries: narração por cima de trechos curtos, com comentário próprio (resumo, análise, opinião)
  {
    key: 'resumo_30',
    group: 'filme',
    label: 'Resumo em 30s',
    emoji: '⚡',
    from: '#6d28d9',
    to: '#fb923c',
    desc: 'O filme ou episódio em 30 segundos: só a premissa, o conflito e o gancho',
    hook: 'A premissa em uma frase de impacto',
    script: 'Parte 1: premissa. Parte 2: o conflito. Parte 3: a pergunta que deixa o público curioso',
    cta: '"Quer a parte 2? Segue"',
    example: 'Esse filme em 30 segundos',
  },
  {
    key: 'resumo_filme',
    group: 'filme',
    label: 'Resumo em 60s',
    emoji: '🎬',
    from: '#7c3aed',
    to: '#f97316',
    desc: 'A história inteira contada rápido, com ritmo de trailer',
    hook: 'A premissa mais absurda em uma frase: "Esse cara acorda todo dia no mesmo dia"',
    script: 'Parte 1: quem é e o que quer. Parte 2: o que dá errado. Parte 3: a virada (sem entregar o final, a não ser que seja spoiler marcado)',
    cta: '"Já assistiu? Nota de 0 a 10 nos comentários"',
    example: 'O filme em que um homem vive o mesmo dia para sempre',
  },
  {
    key: 'ninguem_entendeu',
    group: 'filme',
    label: 'Ninguém entendeu',
    emoji: '🧩',
    from: '#4c1d95',
    to: '#db2777',
    desc: 'O filme/série confuso explicado de um jeito que finalmente faz sentido',
    hook: '"Se você não entendeu esse filme, não é culpa sua"',
    script: 'Parte 1: o que confunde. Parte 2: a regra escondida da história. Parte 3: como tudo se encaixa',
    cta: '"Agora assiste de novo e me conta se mudou tudo"',
    example: 'O filme que ninguém entendeu, explicado em 1 minuto',
  },
  {
    key: 'final_explicado',
    group: 'filme',
    label: 'Final explicado',
    emoji: '🔚',
    from: '#1e1b4b',
    to: '#ea580c',
    desc: 'O desfecho e o que ele significa (sempre com aviso de spoiler)',
    hook: '"Alerta de spoiler: o final de X não é o que você pensa"',
    script: 'Aviso de spoiler → Parte 1: o que acontece no final. Parte 2: as pistas que o filme deu antes. Parte 3: a interpretação',
    cta: '"Qual é a sua teoria? Comenta aqui"',
    example: 'O final de Interestelar explicado',
  },
  {
    key: 'cena_chave',
    group: 'filme',
    label: 'A cena que mudou tudo',
    emoji: '🎞️',
    from: '#9333ea',
    to: '#facc15',
    desc: 'Uma cena curta destrinchada: por que ela é tão marcante',
    hook: '"Essa cena de 30 segundos mudou o filme inteiro"',
    script: 'Parte 1: o contexto antes da cena. Parte 2: o detalhe que quase ninguém nota. Parte 3: o impacto na história',
    cta: '"Qual cena você quer que eu analise?"',
    example: 'A cena que mudou o rumo de Breaking Bad',
  },
  {
    key: 'vale_a_pena',
    group: 'filme',
    label: 'Vale a pena assistir?',
    emoji: '⭐',
    from: '#b45309',
    to: '#7c3aed',
    desc: 'Opinião direta: pontos fortes, fracos e para quem é',
    hook: '"Vale a pena assistir X? Resposta curta: depende de uma coisa"',
    script: 'Parte 1: do que se trata (sem spoiler). Parte 2: o melhor e o pior. Parte 3: veredito e para quem é',
    cta: '"Assistiria? Responde sim ou não"',
    example: 'Vale a pena assistir Duna 2?',
  },
];

export const curiosityTemplate = (key: string) => CURIOSITY_TEMPLATES.find((t) => t.key === key) ?? CURIOSITY_TEMPLATES[1];

/** Uma ideia de vídeo curto de curiosidade: trechos do vídeo-fonte + roteiro de narração. */
export interface CuriosityIdea {
  id: string;
  template: CuriosityTemplateKey;
  title: string;
  /** Texto que aparece e é falado nos primeiros segundos. */
  hook: string;
  /** Roteiro completo da narração (gancho + miolo + CTA), lido pelo narrador. */
  script: string;
  cta: string;
  /** Trechos do vídeo-fonte (s, absolutos), na ordem em que aparecem. */
  segments: { start: number; end: number; label?: string | null }[];
  score: number;
  reason: string;
  hashtags: string[];
  /** Revela o final/reviravolta: o vídeo mostra "alerta de spoiler" e a narração avisa antes. */
  spoiler?: boolean;
  /** Criada à mão no painel (sem IA). */
  manual?: boolean;
}

/** Resultado da análise de um vídeo-fonte (data/curiosities/<jobId>.json). */
export interface CuriosityAnalysis {
  jobId: string;
  videoName: string;
  inputPath: string;
  duration: number;
  language: string;
  provider: string;
  summary: string;
  ideas: CuriosityIdea[];
  createdAt: string;
}
