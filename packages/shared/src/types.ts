// Tipos compartilhados entre UI, API e worker. Este arquivo não pode importar módulos Node.
import type { CleanSpec, CleanStems } from './clean';
import type { CuriosityIdea, CuriosityTemplateKey } from './curiosity';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type ClipStatus = 'pending' | 'rendering' | 'completed' | 'failed';

export type Intensity = 'low' | 'medium' | 'high';
/** youtube: podcasts/entrevistas/vlogs. twitch: lives (jogos, IRL, interação com chat). */
export type ContentMode = 'youtube' | 'twitch';
export type TwitchCategory = 'funny' | 'scary' | 'top5' | 'chat' | 'roast' | 'quotes' | 'highlights' | 'reaction';
/** auto: detecta facecam; split: facecam em cima + jogo embaixo; full: enquadramento normal. */
export type TwitchLayout = 'auto' | 'split' | 'full';

export const TWITCH_CATEGORIES: { key: TwitchCategory; label: string; desc: string }[] = [
  { key: 'funny', label: 'Mais engraçados', desc: 'risadas, piadas, situações absurdas' },
  { key: 'scary', label: 'Tensos / assustadores', desc: 'sustos, jumpscares, momentos de tensão' },
  { key: 'top5', label: 'Top 5 da live', desc: 'compilação com os 5 momentos que mais chamaram atenção' },
  { key: 'chat', label: 'Interação com o chat', desc: 'respostas a viewers, donates, raids' },
  { key: 'roast', label: 'Zoeira entre pessoas', desc: 'um zoando o outro, provocações' },
  { key: 'quotes', label: 'Falas marcantes', desc: 'frases engraçadas, polêmicas ou memoráveis' },
  { key: 'highlights', label: 'Jogadas e destaques', desc: 'clutches, fails épicos, momentos de skill' },
  { key: 'reaction', label: 'Reações', desc: 'o streamer reagindo a algo que viu e achou engraçado' },
];

export type OutputFormat = 'original' | 'vertical_blur' | 'vertical_crop' | 'square';
export type AiProviderName = 'heuristic' | 'gemini' | 'anthropic' | 'claude-code' | 'ollama';
export type WhisperDevice = 'auto' | 'cuda' | 'cpu';
export type HwAccel = 'none' | 'nvenc';

/**
 * Edição manual de um corte pronto (painel "Editar"): substitui o plano da IA sem chamar a IA.
 * Tempos de memes/sons/zooms/enquadramentos são relativos ao início do corte; trechos, absolutos no vídeo.
 */
export interface ManualEdit {
  segments: { start: number; end: number; label?: string | null }[];
  shots: { at: number; duration: number; type: 'focus' | 'wide'; focusX: number; focusY: number; scale: number }[];
  zooms: { at: number; duration: number; scale: number; focusX: number; focusY: number }[];
  overlays: { type: 'meme' | 'image'; category: string; file: string; at: number; duration: number; position: 'center' | 'top' | 'bottom' | 'top-left' | 'top-right'; scale: number; audioMode: 'meme' | 'video' | 'both' }[];
  sfx: { category: string; file: string; at: number; volume: number; duration?: number }[];
  /** Layout facecam: 1 = como a IA deixou; > 1 aproxima o rosto (recorta mais apertado a câmera). */
  camZoom?: number;
  /** Enquadramento manual por trechos de tempo: substitui shots/facecam da IA quando presente. */
  frames?: ManualFrame[];
}

/** Caixa no quadro ORIGINAL, em frações (0-1). */
export interface FrameBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Enquadramento manual de um intervalo do corte (tempo do plano). single: uma área do vídeo original na tela
 * toda (cover = preenche; blur = inteira com fundo desfocado). split: câmera em cima (box) e conteúdo embaixo (box2),
 * com a câmera ocupando `topRatio` da altura. Usado igual na prévia ao vivo e na renderização.
 */
export interface ManualFrame {
  at: number;
  end: number;
  mode: 'single' | 'split';
  fit: 'cover' | 'blur';
  box: FrameBox;
  box2?: FrameBox;
  topRatio?: number;
  /** Encaixe do bloco de cima no modo split (padrão: preencher). */
  fitTop?: 'cover' | 'blur';
  /** Posição do conteúdo dentro do bloco quando ele aparece inteiro (0 = esquerda/topo, 1 = direita/base; padrão 0,5). */
  alignTop?: { x: number; y: number };
  alignBottom?: { x: number; y: number };
  /** Segundo conteúdo ao lado, no bloco de cima / de baixo (no modo "Um quadro", sideTop vale para a tela). */
  sideTop?: FrameSide | null;
  sideBottom?: FrameSide | null;
}

/**
 * Conteúdo extra ao lado no mesmo bloco: uma imagem, outro vídeo de data/input ou outra cena do vídeo original
 * (outro momento e/ou outra área). Divide a largura do bloco com o conteúdo principal.
 */
export interface FrameSide {
  kind: 'image' | 'video' | 'scene';
  /** Caminho absoluto (imagem da biblioteca ou vídeo de data/input). Em 'scene' o render usa o vídeo original. */
  file?: string;
  /** Vídeo/cena: segundo do arquivo mostrado no início deste enquadramento. */
  start?: number;
  /** Cena: área do vídeo original (frações). */
  box?: FrameBox;
  side: 'left' | 'right';
  /** Fração da largura do bloco ocupada por este conteúdo (0,2 a 0,8). */
  width: number;
  fit: 'cover' | 'blur';
  align?: { x: number; y: number };
}

/** Parâmetros editoriais de um job (o que o painel envia). */
export interface JobSettings {
  /** Duração média alvo dos cortes, em segundos (referência flexível para a IA). */
  targetDuration: number;
  /** Quantidade máxima de cortes, ou 'auto' para a IA decidir. */
  maxClips: number | 'auto';
  intensity: Intensity;
  format: OutputFormat;
  /** 'auto' = detecção pelo Whisper. */
  sourceLanguage: string;
  /** '' = sem tradução. */
  translateTo: string;
  burnSubtitles: boolean;
  exportSrt: boolean;
  removeOldSubtitles: boolean;
  useMemes: boolean;
  useSfx: boolean;
  /** Créditos do vídeo original (ex.: YouTube Creative Commons), adicionados à descrição dos posts. */
  creditTitle: string;
  creditChannel: string;
  creditUrl: string;
  mode: ContentMode;
  /** Job de AJUSTE: refaz só um corte já pronto a partir de um comentário (não reprocessa o vídeo). */
  /** Ajuste de um corte pronto. Com `favoriteId`, ajusta a cópia guardada nos favoritos (e não o corte do job). */
  revision?: { parentJobId: string; clipIndex: number; comment: string; favoriteId?: string; manual?: ManualEdit } | null;
  /** Job que só analisa os clipes de referência (gera o guia de estilo), sem vídeo de entrada. */
  analyzeReferences?: boolean;
  /** Job que analisa um VOD da Twitch pela URL (chat + áudio, sem baixar o vídeo) e acha os melhores momentos. */
  vodAnalysis?: { url: string } | null;
  /** Cortes de um VOD da Twitch: antes do pipeline, baixa só estes trechos (s do VOD) e junta no arquivo de entrada. */
  vodSource?: { vodId: string; url: string; sections: { start: number; end: number; label?: string | null }[] } | null;
  /** Modo Twitch: quais tipos de momento procurar. */
  twitchCategories: TwitchCategory[];
  twitchLayout: TwitchLayout;
  /** Trecho do vídeo (s) em que a IA pode procurar cortes; null = vídeo inteiro. */
  range?: { start: number; end: number } | null;
  /** Áreas marcadas à mão no painel (câmera do streamer e conteúdo do react). */
  manualLayout?: ManualLayout | null;
  /**
   * Canal de curiosidades. analyze: só transcreve e gera ideias (sem render) a partir dos formatos escolhidos;
   * ideas: renderiza estas ideias (trechos aprovados/ajustados no painel), com o narrador opcional.
   */
  curiosity?: CuriosityJob | null;
  /** Canal de memes: transcreve as falas ou renderiza o compilado do projeto (data/meme-studio/projects). */
  meme?: { projectId: string; action: 'transcribe' | 'render' } | null;
  /** Limpar vídeo: corta trechos, tira música/legenda/logo etc. e gera data/output/limpos/<job>.mp4. */
  clean?: CleanSpec | null;
  /** Sessão "a partir de um corte viral": o corte de outra pessoa serve de modelo e o vídeo de entrada é o original. */
  reference?: ReferenceJob | null;
}

export interface CuriosityJob {
  /** targetSeconds: duração alvo de cada vídeo (30 ou 60s): roteiro e trechos cabem nela. */
  analyze?: { templates: CuriosityTemplateKey[]; count: number; topic?: string; targetSeconds?: number } | null;
  ideas?: CuriosityIdea[] | null;
  /** Personagem 2D no canto inferior esquerdo narrando o roteiro (TTS local). */
  narrator?: boolean;
  /** Job de análise de onde as ideias vieram. */
  sourceJobId?: string;
}

/**
 * Recria um corte viral a partir do vídeo ORIGINAL: a IA entende a ideia do corte de referência e gera versões
 * próprias do mesmo momento e cortes novos com a mesma pegada em outras partes. Nada da edição da outra pessoa é usado.
 */
export interface ReferenceJob {
  /** Corte de referência (arquivo em data/input). */
  clipFile: string;
  /** Quantas versões do MESMO momento (3 a 10). */
  variations: number;
  /** Quantos cortes novos, com a mesma pegada, de OUTRAS partes do original (0 = nenhum). */
  otherParts: number;
  /**
   * Quanto do original a IA lê, em minutos, em volta do trecho do corte (limita os tokens).
   * 0 = só o trecho do corte (com um pouco de contexto); null = o vídeo inteiro.
   */
  scanMinutes: number | null;
}

/** Material que a IA pede ao editor (imagem, meme ou som) para um momento de um corte. */
export interface AssetRequest {
  id: string;
  /** Segundos desde o início do corte. */
  at: number;
  duration: number;
  kind: 'image' | 'meme' | 'sound';
  /** O que mostrar/tocar ("foto do Neymar", "logo da Coca-Cola", "som de risada de plateia"). */
  what: string;
  /** Como entra: tela inteira, quadro no canto ou por cima da câmera. */
  display: 'full' | 'corner' | 'top';
  reason: string;
}

/** Retângulo em frações do quadro original (0..1). */
export interface FrameBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Áreas marcadas pelo editor:
 * - cam: o quadradinho do streamer. shape 'circle' marca só o rosto; mode 'fill' expande até a câmera inteira e
 *   ocupa o topo, mode 'bubble' mostra só o rosto num círculo no canto de cima, sobre o conteúdo.
 * - content: a área do vídeo a que ele reage.
 * - track: a IA acompanha se a pessoa/o player se mover (ajusta perto da área marcada); false = área fixa.
 */
export interface ManualLayout {
  cam?: { box: FrameBox; shape: 'rect' | 'circle'; mode: 'fill' | 'bubble'; track: boolean } | null;
  content?: { box: FrameBox; track: boolean } | null;
}

/**
 * Plano de uso do Gemini:
 * - free:   plano gratuito do AI Studio, só Flash (com ritmo de chamadas para respeitar o limite por minuto)
 * - paid:   faturamento ativo, só Flash (sem espera entre chamadas)
 * - hybrid: faturamento ativo, Pro escolhe os cortes e Flash faz edição, títulos, hashtags e tradução
 */
export type GeminiPlan = 'free' | 'paid' | 'hybrid';

/** Papel de cada chamada de IA — define qual modelo é usado no plano combinado. */
export type LLMRole = 'select' | 'edit' | 'translate';

/** Configurações globais da máquina (sem segredos). */
export interface AppSettings {
  aiProvider: AiProviderName;
  geminiPlan: GeminiPlan;
  geminiFlashModel: string;
  geminiProModel: string;
  /** Usado automaticamente quando a cota diária do modelo principal acaba ('' = nenhum). */
  geminiFallbackModel: string;
  /** Diretrizes editoriais livres do usuário, enviadas a todas as chamadas de IA. */
  editingPrompt: string;
  /** Idioma de títulos, legendas de post e hashtags ('' = mesmo idioma do vídeo). */
  postLanguage: string;
  /** Gera sempre um texto em português do que é falado (transcricao_pt.txt). */
  ptTranscript: boolean;
  /** Legenda antiga: crop = enquadrar sem a faixa (limpo); inpaint = apagar o texto e preencher. */
  subtitleRemoval: 'crop' | 'inpaint';
  /** Usa o guia de estilo aprendido dos clipes em data/references nas seleções e edições. */
  useReferences: boolean;
  /** Claude que escolhe os cortes (o mais capaz). */
  anthropicSelectModel: string;
  anthropicModel: string;
  /** Modelo do Claude Code (assinatura): alias como sonnet / opus, ou o nome completo. */
  claudeCodeModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  whisperModel: string;
  whisperDevice: WhisperDevice;
  threads: number;
  hwAccel: HwAccel;
  sendFramesToAI: boolean;
  /** Ilustra o que é falado (avião, filme, pessoa) com imagens de bancos de licença livre. */
  useIllustrations: boolean;
}

export const DEFAULT_JOB_SETTINGS: JobSettings = {
  targetDuration: 25,
  maxClips: 'auto',
  intensity: 'medium',
  format: 'vertical_blur',
  sourceLanguage: 'auto',
  translateTo: '',
  burnSubtitles: true,
  exportSrt: true,
  removeOldSubtitles: true,
  // Por enquanto só os cortes: memes e sons ficam desligados (podem ser ligados no formulário)
  useMemes: false,
  useSfx: false,
  creditTitle: '',
  creditChannel: '',
  creditUrl: '',
  mode: 'youtube',
  twitchCategories: ['funny', 'scary', 'top5', 'chat', 'roast', 'quotes', 'highlights', 'reaction'],
  twitchLayout: 'auto',
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  aiProvider: 'gemini',
  geminiPlan: 'free',
  geminiFlashModel: 'gemini-3-flash-preview',
  geminiProModel: 'gemini-3.1-pro-preview',
  geminiFallbackModel: 'gemini-3.1-flash-lite',
  editingPrompt: '',
  postLanguage: 'pt',
  ptTranscript: true,
  subtitleRemoval: 'crop',
  useReferences: true,
  anthropicSelectModel: 'claude-opus-5-5',
  anthropicModel: 'claude-sonnet-5-5',
  claudeCodeModel: 'sonnet',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3',
  whisperModel: 'small',
  whisperDevice: 'auto',
  threads: 4,
  hwAccel: 'none',
  sendFramesToAI: true,
  useIllustrations: true,
};

export interface Job {
  id: string;
  status: JobStatus;
  step: string;
  progress: number;
  inputPath: string;
  videoName: string;
  settings: JobSettings;
  error: string | null;
  result: JobResult | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobResult {
  outputDir?: string;
  provider?: string;
  /** Uso de tokens e custo estimado das chamadas de IA. */
  aiUsage?: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; free: boolean };
  language?: string;
  clipsRendered?: number;
  clipsFailed?: number;
  /** Análise de VOD da Twitch: id do VOD (resultado em data/vods/<id>/peaks.json). */
  vodId?: string;
  /** Limpar vídeo: arquivo final limpo. */
  cleanOutput?: string;
  /** Limpar vídeo: faixas separadas para baixar. */
  cleanStems?: CleanStems;
}

export interface JobLog {
  id: number;
  jobId: string;
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface Clip {
  id: string;
  jobId: string;
  index: number;
  title: string;
  start: number;
  end: number;
  score: number;
  reason: string;
  status: ClipStatus;
  outputPath: string | null;
  srtPath: string | null;
  metadataPath: string | null;
  error: string | null;
  /** Legenda de postagem sugerida pela IA. */
  description: string | null;
  hashtags: string[];
}

/** Corte favoritado: cópia independente do job (sobrevive a reprocessar ou excluir o job). */
export interface Favorite {
  id: string;
  jobId: string;
  clipIndex: number;
  videoName: string;
  title: string;
  description: string | null;
  hashtags: string[];
  /** Pasta própria em data/favorites/<id> com vídeo, capa, SRT, metadados e transcrição. */
  dir: string;
  videoPath: string;
  srtPath: string | null;
  metadataPath: string;
  duration: number;
  /** Quando foi favoritado (ISO). */
  favoritedAt: string;
  updatedAt: string;
}

export interface Preset {
  id: string;
  name: string;
  settings: JobSettings;
  builtin: boolean;
  createdAt: string;
}

// ---- Mídia / transcrição ----

export interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string | null;
  audioCodec: string | null;
  audioTracks: number;
  hasAudio: boolean;
  hasVideo: boolean;
  sizeBytes: number;
  bitRate: number | null;
}

export interface TranscriptWord {
  start: number;
  end: number;
  word: string;
  probability?: number;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}

export interface Transcript {
  language: string;
  languageProbability?: number;
  duration: number;
  device?: string;
  model?: string;
  segments: TranscriptSegment[];
}

export interface LibraryCategory {
  name: string;
  files: string[];
}

export interface LibraryIndex {
  memes: LibraryCategory[];
  audio: LibraryCategory[];
  images: LibraryCategory[];
}

export const PIPELINE_STEPS = [
  { key: 'ingest', label: 'Ingestão & validação' },
  { key: 'transcribe', label: 'Transcrição (Whisper)' },
  { key: 'frames', label: 'Amostragem visual' },
  { key: 'select', label: 'Seleção de cortes (IA)' },
  { key: 'plan', label: 'Plano de edição' },
  { key: 'subtitles', label: 'Legendas antigas / tradução' },
  { key: 'render', label: 'Renderização FFmpeg' },
  { key: 'export', label: 'Exportação' },
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number]['key'];
