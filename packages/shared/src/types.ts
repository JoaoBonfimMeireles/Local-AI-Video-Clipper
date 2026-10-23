// Tipos compartilhados entre UI, API e worker. Este arquivo não pode importar módulos Node.

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
export type AiProviderName = 'heuristic' | 'gemini' | 'anthropic' | 'ollama';
export type WhisperDevice = 'auto' | 'cuda' | 'cpu';
export type HwAccel = 'none' | 'nvenc';

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
  revision?: { parentJobId: string; clipIndex: number; comment: string; favoriteId?: string } | null;
  /** Job que só analisa os clipes de referência (gera o guia de estilo), sem vídeo de entrada. */
  analyzeReferences?: boolean;
  /** Modo Twitch: quais tipos de momento procurar. */
  twitchCategories: TwitchCategory[];
  twitchLayout: TwitchLayout;
  /** Trecho do vídeo (s) em que a IA pode procurar cortes; null = vídeo inteiro. */
  range?: { start: number; end: number } | null;
  /** Áreas marcadas à mão no painel (câmera do streamer e conteúdo do react). */
  manualLayout?: ManualLayout | null;
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
  useMemes: true,
  useSfx: true,
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
