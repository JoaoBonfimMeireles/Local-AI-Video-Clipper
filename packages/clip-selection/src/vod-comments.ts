// Comentários do chat que dizem "essa parte foi boa": elogios, "melhor parte", risadas longas, "clipa isso".
// Segundo sinal do calor da live, além dos picos: não mede QUANTO o chat fala, e sim O QUE ele fala.
//
// Fácil de editar: cada frase é escrita do jeito natural; o código normaliza (minúsculas, sem acento, letras
// repetidas viram uma só: "muitoooo" = "muito", "carro" = "caro") tanto a frase quanto a mensagem, então
// alongamentos e boa parte dos erros de digitação já casam sem precisar listar. A frase casa como palavra
// inteira dentro da mensagem ("muito bom" casa em "nossa muito bom mano").

/** Frases de reação positiva/engraçada. Variações de gíria, abreviação e erro comum ficam explícitas. */
export const PRAISE_PHRASES: string[] = [
  // "melhor parte"
  'melhor parte', 'melhor parte do video', 'melhor parte da live', 'melhor parte da stream', 'melhor momento', 'melhor momento da live',
  'melhor cena', 'melhor coisa', 'melhor coisa da live', 'melhor live', 'momento da live', 'momento do ano', 'cena do ano', 'clipe do ano',
  'parte mais engracada', 'parte mais legal', 'parte mais braba', 'parte mais insana', 'top 1', 'top1', 'top 10 momentos',
  'mlhr parte', 'mlr parte', 'melhro parte', 'mehor parte', 'melho parte', 'best part', 'best moment', 'best clip', 'peak content', 'cinema',
  'cinema puro', 'cinematografico', 'obra de arte', 'obra prima', 'historico', 'momento historico', 'entrou pra historia', 'pra historia',
  // pedidos de clipe
  'clipa', 'clipa isso', 'clipa ai', 'clipaa', 'clip it', 'clip that', 'clipped', 'clipei', 'clipado', 'alguem clipa', 'alguem clipou', 'ja clipei',
  'manda pro tiktok', 'vai pro tiktok', 'vai viralizar', 'viralizou', 'isso vai viralizar', 'vai ter corte', 'vira corte',
  'replay', 'volta ai', 'volta a cena', 'de novo', 'denovo', 'dnv', 'mais uma vez', 'again', 'run it back',
  // engraçado
  'muito engracado', 'mt engracado', 'mto engracado', 'mui engracado', 'engracado demais', 'que engracado', 'q engracado', 'engracadissimo',
  'muito engraçado', 'engrassado', 'engracadu', 'que isso kk', 'morri', 'morri de rir', 'morri kk', 'to morrendo', 'tô morrendo', 'to mortinho',
  'chorei', 'chorei de rir', 'to chorando', 'tô chorando', 'chorando de rir', 'rindo muito', 'rindo demais', 'nao paro de rir', 'não paro de rir',
  'rachei', 'rachei de rir', 'gargalhei', 'me mijei', 'me mijei de rir', 'perdi o ar', 'sem ar', 'nao respiro', 'falta de ar', 'acabou comigo',
  'me quebrou', 'quebrou tudo', 'destruiu', 'humilhou', 'humilhacao', 'humilhado', 'zoou', 'zoeira', 'que zoeira', 'palhaco', 'palhacada',
  'comedia', 'comediante', 'stand up', 'standup', 'piada', 'que piada', 'hilario', 'hilariante', 'hilaria', 'funny', 'so funny', 'lmao', 'lmfao',
  'rofl', 'lol', 'loool', 'im dead', 'i cant', 'icant', 'nao aguento', 'não aguento', 'nao consigo', 'não consigo', 'socorro', 'socorr',
  'pelo amor', 'pelo amor de deus', 'pqp', 'puta que pariu', 'putz', 'caraca', 'caramba', 'carai', 'caralho', 'krl', 'crl', 'kct',
  'meu deus', 'meu deuss', 'mds', 'meudeus', 'misericordia', 'nossa', 'nss', 'noss', 'que isso', 'q isso', 'oq foi isso',
  'o que foi isso', 'que foi isso', 'oque foi isso', 'wtf', 'omg', 'oh my god', 'bruh', 'nao acredito', 'não acredito', 'nao creio',
  'inacreditavel', 'impossivel', 'surreal', 'bizarro', 'absurdo', 'que absurdo', 'loucura', 'que loucura', 'maluco', 'doido', 'doideira',
  'insano', 'insana', 'insanidade', 'brabo', 'braba', 'brabissimo', 'brabo demais', 'muito brabo', 'mt brabo', 'muito pesado',
  // "muito bom/legal"
  'muito bom', 'mt bom', 'mto bom', 'mui bom', 'muito boa', 'mt boa', 'bom demais', 'boa demais', 'que bom', 'muito legal', 'mt legal',
  'mto legal', 'legal demais', 'que legal', 'q legal', 'muito massa', 'massa demais', 'que massa', 'muito top', 'mt top', 'top demais',
  'que top', 'topzera', 'topper', 'muito foda', 'mt foda', 'foda demais', 'que foda', 'q foda', 'fodastico', 'fodase que bom', 'foda pra caralho',
  'sensacional', 'espetacular', 'incrivel', 'incrivel demais', 'fantastico', 'maravilhoso', 'perfeito', 'perfeicao', 'genial', 'genio',
  'monstruoso', 'craque', 'lenda', 'lendario', 'goat', 'o goat', 'goated', 'mitou', 'mitada', 'que mito', 'brilhante',
  'show de bola', 'showw', 'que show', 'que animal', 'muito demais', 'absurdo de bom', 'outro nivel',
  'deu aula', 'masterclass', 'jogada', 'que jogada', 'que lance', 'clutch', 'que clutch', 'ace', 'ggwp',
  'amei', 'amo demais', 'adorei', 'curti muito', 'i love it', 'chefs kiss', 'perfect', 'insane', 'crazy',
  'amazing', 'awesome', 'incredible', 'legendary', 'epic', 'epico', 'que epico', 'hype', 'hypado', 'arrepiei', 'arrepiante', 'to arrepiado',
  // susto/choque que costuma dar corte
  'que susto', 'tomei um susto', 'me assustei', 'pulei', 'pulei da cadeira', 'gritei', 'ele gritou', 'que grito', 'kkk o grito',
];

/** Risadas longas e reações onomatopeicas: casam na mensagem ORIGINAL (o tamanho importa: "kk" não conta). */
const LAUGH_PATTERNS: [RegExp, string][] = [
  [/(^|\s)k{4,}(\s|$)/i, 'kkkk'],
  [/(^|\s)(ks){3,}k?(\s|$)/i, 'kkkk'],
  [/(^|\s)(ka|kj|kd|kl|kk){3,}(\s|$)/i, 'kkkk'],
  [/(^|\s)(ha|ah|he|hah){3,}h?(\s|$)/i, 'hahaha'],
  [/(^|\s)(rs){2,}(\s|$)/i, 'rsrs'],
  [/(^|\s)(hue){2,}(\s|$)/i, 'huehue'],
  [/(^|\s)(ja|xd){3,}(\s|$)/i, 'hahaha'],
  [/(😂|🤣|💀){2,}/u, '😂😂'],
  [/(^|\s)(kekw|omegalul|lulw|icant)(\s+(kekw|omegalul|lulw|icant)){2,}/i, 'KEKW KEKW'],
];

export const LAUGH_LABELS = new Set(LAUGH_PATTERNS.map(([, label]) => label));

/** Minúsculas, sem acento, só letras/números/espaço, letras repetidas viram uma só. */
export function normalizeChat(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/([a-z])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalizada → como foi escrita (o rótulo mostra "clipa isso", não "clipa iso")
const PHRASES = [...new Map(PRAISE_PHRASES.map((p) => [normalizeChat(p), p] as const).filter(([n]) => n)).entries()]
  // A mais longa primeiro: "melhor parte da live" ganha de "melhor parte" como rótulo
  .sort((a, b) => b[0].length - a[0].length)
  .map(([p, label]) => ({ label, rx: new RegExp(`(^| )${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`) }));

/** Rótulo do comentário de reação que a mensagem contém, ou null. */
export function matchPraise(text: string): string | null {
  for (const [rx, label] of LAUGH_PATTERNS) if (rx.test(text)) return label;
  const norm = normalizeChat(text);
  if (!norm) return null;
  for (const p of PHRASES) if (p.rx.test(norm)) return p.label;
  return null;
}
