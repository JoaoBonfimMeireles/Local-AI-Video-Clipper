import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Guarda só o fim do stderr para mensagens de erro (FFmpeg é muito verboso). */
  stderrTailBytes?: number;
  captureStdout?: boolean;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderrTail: string;
}

export class ProcessError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly stderrTail: string,
  ) {
    super(message);
  }
}

/**
 * Encerra o processo e seus filhos. No Windows o python.exe do venv é um launcher que cria
 * outro processo; matar só o launcher deixaria o Python real (e a GPU) ocupado.
 */
function killTree(pid: number | undefined, fallback: () => void) {
  if (process.platform === 'win32' && pid) {
    const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    tk.on('error', fallback);
    return;
  }
  fallback();
}

/** Processos filhos vivos, para encerrá-los se o worker for finalizado. */
const liveChildren = new Set<number>();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const pid of liveChildren) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', detached: true });
        else process.kill(pid, 'SIGKILL');
      } catch {
        /* já encerrado */
      }
    }
  });
}

/**
 * Executa um binário SEM shell: cada argumento vai separado para o processo,
 * então nenhum texto vindo da IA pode ser interpretado como comando.
 */
export function runProcess(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  for (const a of args) {
    if (typeof a !== 'string' || a.includes('\0')) throw new Error('Argumento de processo inválido');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    installExitHook();
    if (child.pid) liveChildren.add(child.pid);
    child.on('exit', () => child.pid && liveChildren.delete(child.pid));
    const tailMax = opts.stderrTailBytes ?? 8000;
    let stderrTail = '';
    const stdoutChunks: string[] = [];
    let outBuf = '';
    let errBuf = '';

    const onAbort = () => killTree(child.pid, () => child.kill('SIGKILL'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = opts.timeoutMs ? setTimeout(onAbort, opts.timeoutMs) : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (opts.captureStdout !== false) stdoutChunks.push(d);
      if (opts.onStdoutLine) {
        outBuf += d;
        const lines = outBuf.split(/\r?\n/);
        outBuf = lines.pop() ?? '';
        for (const l of lines) opts.onStdoutLine(l);
      }
    });
    child.stderr.on('data', (d: string) => {
      stderrTail = (stderrTail + d).slice(-tailMax);
      if (opts.onStderrLine) {
        errBuf += d;
        const lines = errBuf.split(/\r?\n|\r/);
        errBuf = lines.pop() ?? '';
        for (const l of lines) opts.onStderrLine(l);
      }
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (outBuf && opts.onStdoutLine) opts.onStdoutLine(outBuf);
      if (errBuf && opts.onStderrLine) opts.onStderrLine(errBuf);
      if (opts.signal?.aborted) return reject(new ProcessError('Processo cancelado', code, stderrTail));
      resolve({ code, stdout: stdoutChunks.join(''), stderrTail });
    });
  });
}
