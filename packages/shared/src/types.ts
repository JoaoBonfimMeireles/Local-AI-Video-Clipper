// Tipos compartilhados entre UI, API e worker. Este arquivo não pode importar módulos Node.

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type ClipStatus = 'pending' | 'rendering' | 'completed' | 'failed';

export type Intensity = 'low' | 'medium' | 'high';
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
}

/** Configurações globais da máquina (sem segredos). */
export interface AppSettings {
  aiProvider: AiProviderName;
  geminiModel: string;
  anthropicModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  whisperModel: string;
  whisperDevice: WhisperDevice;
  threads: number;
  hwAccel: HwAccel;
  sendFramesToAI: boolean;
}

export const DEFAULT_JOB_SETTINGS: JobSettings = {
  targetDuration: 60,
  maxClips: 'auto',
  intensity: 'medium',
  format: 'vertical_blur',
  sourceLanguage: 'auto',
  translateTo: '',
  burnSubtitles: true,
  exportSrt: true,
  removeOldSubtitles: false,
  useMemes: true,
  useSfx: true,
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  aiProvider: 'heuristic',
  geminiModel: 'gemini-2.5-flash',
  anthropicModel: 'claude-sonnet-5-5',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3',
  whisperModel: 'small',
  whisperDevice: 'auto',
  threads: 4,
  hwAccel: 'none',
  sendFramesToAI: true,
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
