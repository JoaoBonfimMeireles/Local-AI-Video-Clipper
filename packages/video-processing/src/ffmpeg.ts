import { ProcessError, resolveBinary, runProcess } from '@clipper/shared/server';

export interface FfmpegRunOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Duração esperada da saída (s) para calcular o progresso. */
  expectedDuration?: number;
  onProgress?: (p: number) => void;
  onStderrLine?: (line: string) => void;
}

/** Executa o FFmpeg com argumentos em array (nunca via shell) e reporta progresso por -progress. */
export async function runFfmpeg(args: string[], opts: FfmpegRunOptions = {}): Promise<{ stderrTail: string }> {
  const full = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args];
  const res = await runProcess(resolveBinary('ffmpeg'), full, {
    cwd: opts.cwd,
    signal: opts.signal,
    captureStdout: false,
    stderrTailBytes: 12000,
    onStderrLine: opts.onStderrLine,
    onStdoutLine: (line) => {
      if (!opts.onProgress || !opts.expectedDuration) return;
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m) opts.onProgress(Math.min(1, Number(m[1]) / 1e6 / opts.expectedDuration));
    },
  });
  if (res.code !== 0) {
    // A causa costuma aparecer antes das linhas genéricas de "Terminating thread": prioriza-a.
    const lines = res.stderrTail.split(/\r?\n/).filter(Boolean);
    const cause = lines.filter((l) => /invalid|error|failed|no such|not found|unable|cannot/i.test(l) && !/Terminating thread|Task finished/i.test(l)).slice(0, 4);
    const tail = [...new Set([...cause, ...lines.slice(-4)])].join('\n');
    throw new ProcessError(`FFmpeg falhou (código ${res.code}):\n${tail}`, res.code, res.stderrTail);
  }
  return { stderrTail: res.stderrTail };
}

export async function runFfprobeJson(args: string[], signal?: AbortSignal): Promise<any> {
  const res = await runProcess(resolveBinary('ffprobe'), ['-v', 'error', '-print_format', 'json', ...args], {
    signal,
    timeoutMs: 120_000,
  });
  if (res.code !== 0) throw new Error(`FFprobe falhou: ${res.stderrTail.trim().split('\n').pop()}`);
  return JSON.parse(res.stdout || '{}');
}

/** Formata segundos para argumentos -ss/-t (sempre numérico, nunca string externa). */
export function sec(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(`Tempo inválido: ${n}`);
  return n.toFixed(3);
}
