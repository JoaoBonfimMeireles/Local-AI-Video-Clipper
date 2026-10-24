// Melhores momentos de um VOD da Twitch SEM baixar o vídeo: picos de chat (relativos à própria live),
// reações por tipo de emote e energia do áudio, em janelas de 5 s. Código puro (sem I/O): o worker
// agrega o chat e o áudio em `VodBin`s e este módulo dá a nota e escolhe os momentos.

/** Tamanho de cada janela de análise (s). */
export const VOD_BIN_SECONDS = 5;

export type ReactionKind = 'funny' | 'hype' | 'scary' | 'sad';

/**
 * Reações do chat. Fácil de editar: cada item é um emote/palavra exata (sem diferenciar maiúsculas) ou uma
 * expressão regular (entre barras). Um emote que aparece várias vezes na mesma mensagem conta uma vez.
 */
export const CHAT_REACTIONS: Record<ReactionKind, string[]> = {
  funny: ['KEKW', 'LUL', 'LULW', 'OMEGALUL', 'ICANT', 'Kappa', 'pepeLaugh', 'KEKWait', '/^k{4,}$/', '/^(rs){2,}$/', 'rs', '/^(ha){3,}$/', '/^kk+$/', '😂', '🤣'],
  hype: ['Pog', 'PogChamp', 'POGGERS', 'PogU', 'Poggers', 'PagMan', 'EZ', 'GG', 'HYPE', '/^po+g$/i', '🔥'],
  scary: ['monkaS', 'monkaW', 'monkaGIGA', 'D:', 'WTF', '/^\\?{3,}$/', '😱'],
  sad: ['F', 'Sadge', 'BibleThump', 'PepeHands', 'NotLikeThis', 'FeelsBadMan', '😭'],
};

export const REACTION_LABEL: Record<ReactionKind | 'chat' | 'audio', string> = {
  funny: 'engraçado',
  hype: 'hype',
  scary: 'susto/confusão',
  sad: 'fail/triste',
  chat: 'chat agitado',
  audio: 'streamer gritando/energia',
};

type Matcher = { kind: ReactionKind; test: (token: string) => boolean };

function compileReactions(list = CHAT_REACTIONS): Matcher[] {
  const out: Matcher[] = [];
  for (const [kind, items] of Object.entries(list) as [ReactionKind, string[]][]) {
    for (const item of items) {
      const re = /^\/(.+)\/([a-z]*)$/.exec(item);
      if (re) {
        const rx = new RegExp(re[1], re[2].includes('i') ? 'i' : '');
        out.push({ kind, test: (t) => rx.test(t) });
      } else {
        const low = item.toLowerCase();
        out.push({ kind, test: (t) => t.toLowerCase() === low });
      }
    }
  }
  return out;
}

const MATCHERS = compileReactions();

/** Reações de uma mensagem: tipos presentes e os tokens que casaram (para "emotes principais"). */
export function classifyMessage(text: string): { kinds: Set<ReactionKind>; tokens: string[] } {
  const kinds = new Set<ReactionKind>();
  const tokens: string[] = [];
  for (const token of new Set(text.split(/\s+/).filter(Boolean))) {
    const m = MATCHERS.find((x) => x.test(token));
    if (m) {
      kinds.add(m.kind);
      // "kkkkkkk" e "kkkk" contam como o mesmo emote
      tokens.push(/^k+$/i.test(token) ? 'kkkk' : /^(rs)+$/i.test(token) ? 'rsrs' : /^(ha)+$/i.test(token) ? 'haha' : token);
    }
  }
  return { kinds, tokens };
}

/** Uma janela de 5 s do VOD. */
export interface VodBin {
  /** Início da janela (s). */
  t: number;
  /** Mensagens no chat. */
  msgs: number;
  /** Mensagens com cada tipo de reação. */
  react: Record<ReactionKind, number>;
  /** Contagem dos emotes de reação nesta janela (para "emotes principais"). */
  tokens: Record<string, number>;
  /** Volume RMS do áudio (dBFS; -90 = silêncio/sem dado). */
  rms: number;
}

export function emptyBin(t: number): VodBin {
  return { t, msgs: 0, react: { funny: 0, hype: 0, scary: 0, sad: 0 }, tokens: {}, rms: -90 };
}

export function addMessage(bin: VodBin, text: string): void {
  bin.msgs++;
  const { kinds, tokens } = classifyMessage(text);
  for (const k of kinds) bin.react[k]++;
  for (const tk of tokens) bin.tokens[tk] = (bin.tokens[tk] ?? 0) + 1;
}

/** Mediana móvel (janela ±half), robusta a picos: é a "média da própria live" naquele trecho. */
function rollingMedian(values: number[], half: number): number[] {
  const out: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const w = values.slice(Math.max(0, i - half), Math.min(values.length, i + half + 1)).sort((a, b) => a - b);
    out[i] = w[w.length >> 1] ?? 0;
  }
  return out;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface VodScore {
  t: number;
  score: number;
  chat: number;
  react: number;
  audio: number;
}

/**
 * Nota de 0 a 1 por janela. Picos RELATIVOS: compara cada janela com a mediana dos ±5 min ao redor, então
 * uma live com chat enorme e outra com chat pequeno são tratadas igual. O chat reage 3-10 s depois do
 * acontecimento: a energia do áudio entra com o máximo dos ~10 s ANTERIORES a cada janela.
 */
export function scoreBins(bins: VodBin[], opts: { hasAudio?: boolean } = {}): VodScore[] {
  const half = Math.round(300 / VOD_BIN_SECONDS);
  const msgs = bins.map((b) => b.msgs);
  const reacts = bins.map((b) => b.react.funny + b.react.hype + b.react.scary + b.react.sad);
  const baseMsgs = rollingMedian(msgs, half);
  const baseReact = rollingMedian(reacts, half);
  const voiced = bins.map((b) => (b.rms > -70 ? b.rms : NaN));
  const baseRms = rollingMedian(voiced.map((v) => (Number.isNaN(v) ? -70 : v)), half);
  const raw = bins.map((b, i) => {
    const chat = clamp01((msgs[i] / (baseMsgs[i] + 1) - 1) / 3); // 4x o normal = nota máxima
    const react = clamp01((reacts[i] / (baseReact[i] + 0.5) - 1) / 4);
    const lag = Math.round(10 / VOD_BIN_SECONDS);
    let loud = -90;
    for (let k = Math.max(0, i - lag); k <= i; k++) loud = Math.max(loud, bins[k].rms);
    const audio = opts.hasAudio === false ? 0 : clamp01((loud - baseRms[i]) / 8); // 8 dB acima do normal
    // Chat pesa mais (é o "termômetro" do público); áudio confirma
    const score = opts.hasAudio === false ? 0.65 * chat + 0.35 * react : 0.5 * chat + 0.25 * react + 0.25 * audio;
    return { t: b.t, score, chat, react, audio };
  });
  // Suaviza 3 janelas para um pico isolado de 5 s não vencer um momento sustentado
  return raw.map((r, i) => ({ ...r, score: (raw[Math.max(0, i - 1)].score + 2 * r.score + raw[Math.min(raw.length - 1, i + 1)].score) / 4 }));
}

export interface VodMoment {
  rank: number;
  /** Início/fim sugeridos (s): começa antes do pico do chat para incluir a ação que gerou a reação. */
  start: number;
  end: number;
  /** Instante do pico de reação do chat (s). */
  peak: number;
  score: number;
  type: ReactionKind | 'chat' | 'audio';
  typeLabel: string;
  /** Emotes de reação mais usados no momento. */
  emotes: string[];
  /** Mensagens por minuto no pico e o normal da live ali perto. */
  chatPerMin: number;
}

/**
 * Junta janelas vizinhas, aplica supressão de não-máximos (um momento por vizinhança) e devolve os N
 * melhores. Início = pico do chat - lead (a reação vem depois da ação); fim = enquanto a nota segue alta.
 */
export function pickVodMoments(bins: VodBin[], scores: VodScore[], opts: { count?: number; lead?: number; minGap?: number; duration?: number } = {}): VodMoment[] {
  const count = opts.count ?? 15;
  const lead = opts.lead ?? 20;
  const minGap = opts.minGap ?? 45;
  const duration = opts.duration ?? (bins.length ? bins[bins.length - 1].t + VOD_BIN_SECONDS : 0);
  const order = scores.map((s, i) => i).sort((a, b) => scores[b].score - scores[a].score);
  const chosen: number[] = [];
  for (const i of order) {
    if (chosen.length >= count || scores[i].score < 0.08) break;
    if (chosen.some((j) => Math.abs(scores[j].t - scores[i].t) < minGap)) continue;
    chosen.push(i);
  }
  return chosen.map((p, k) => {
    const peakScore = scores[p].score;
    // Estende enquanto as janelas seguintes continuam fortes (momento sustentado), até 60 s
    let last = p;
    while (last + 1 < scores.length && scores[last + 1].score >= peakScore * 0.6 && (last + 1 - p) * VOD_BIN_SECONDS < 45) last++;
    const start = Math.max(0, scores[p].t - lead);
    const end = Math.min(duration, scores[last].t + VOD_BIN_SECONDS + 10);
    const around = bins.slice(Math.max(0, p - 1), Math.min(bins.length, last + 2));
    const kinds = (['funny', 'hype', 'scary', 'sad'] as ReactionKind[]).map((kind) => ({ kind, n: around.reduce((a, b) => a + b.react[kind], 0) })).sort((a, b) => b.n - a.n);
    const s = scores[p];
    const type: VodMoment['type'] = kinds[0].n >= 3 ? kinds[0].kind : s.audio > s.chat ? 'audio' : 'chat';
    const tokenTotals: Record<string, number> = {};
    for (const b of around) for (const [tk, n] of Object.entries(b.tokens)) tokenTotals[tk] = (tokenTotals[tk] ?? 0) + n;
    return {
      rank: k + 1,
      start: Math.round(start),
      end: Math.round(end),
      peak: Math.round(s.t),
      score: Math.round(peakScore * 100),
      type,
      typeLabel: REACTION_LABEL[type],
      emotes: Object.entries(tokenTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([tk]) => tk),
      chatPerMin: Math.round((bins[p].msgs * 60) / VOD_BIN_SECONDS),
    };
  });
}
