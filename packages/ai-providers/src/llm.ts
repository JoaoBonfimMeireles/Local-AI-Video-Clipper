import fs from 'node:fs';
import type { AppSettings, LLMRole } from '@clipper/shared';
import { getEnvValue } from '@clipper/shared/server';

export interface LLMImage {
  mimeType: 'image/jpeg' | 'image/png';
  base64: string;
}

export interface LLMRequest {
  system: string;
  prompt: string;
  images?: LLMImage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LLMProvider {
  name: string;
  model: string;
  supportsImages: boolean;
  /** Tamanho máximo de transcrição por chamada (caracteres); acima disso o texto é dividido. */
  maxPromptChars: number;
  /** true quando as chamadas não geram cobrança (plano gratuito / modelo local). */
  free: boolean;
  usage: LLMUsage;
  /** Avisos operacionais (ex.: troca para o modelo reserva) — o pipeline registra nos logs do job. */
  onNotice?: (msg: string) => void;
  complete(req: LLMRequest): Promise<string>;
}

const TIMEOUT_MS = 5 * 60_000;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

function withTimeout(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    host: string,
  ) {
    super(`HTTP ${status} de ${host}: ${body.slice(0, 400)}`);
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: withTimeout(signal),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text, new URL(url).host);
  return JSON.parse(text);
}

/** Preço público por 1M tokens (US$) — usado só para estimar custo nos logs. Saída inclui "thinking". */
const GEMINI_PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /pro/i, input: 2.0, output: 12.0 },
  { match: /3\.[68]-flash/i, input: 0.75, output: 3.75 },
  { match: /flash-lite/i, input: 0.25, output: 1.5 },
  { match: /3-flash/i, input: 0.5, output: 3.0 },
  { match: /flash/i, input: 0.3, output: 2.5 },
];

export function estimateCostUsd(model: string, usage: LLMUsage): number {
  const p = GEMINI_PRICES.find((x) => x.match.test(model));
  if (!p) return 0;
  return (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1e6;
}

/** No plano gratuito, todas as instâncias compartilham o mesmo ritmo (o limite é por projeto/minuto). */
let lastGeminiCall = 0;
/** Modelos cuja cota DIÁRIA acabou hoje (vale para todos os jobs até a virada do dia). */
const exhaustedToday = new Map<string, string>();
const today = () => new Date().toISOString().slice(0, 10);
const isExhausted = (model: string) => exhaustedToday.get(model) === today();

class GeminiProvider implements LLMProvider {
  name = 'gemini';
  supportsImages = true;
  maxPromptChars = 600_000;
  usage: LLMUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  private thinkingSupported = true;
  onNotice?: (msg: string) => void;

  constructor(
    public model: string,
    private apiKey: string,
    public free: boolean,
    /** Nível de raciocínio do Gemini 3: alto para escolher cortes, baixo para tarefas rápidas. */
    private thinkingLevel: 'low' | 'high',
    /** Modelo usado quando a cota diária do principal acaba (ex.: Flash-Lite, que tem cota própria). */
    private fallbackModel = '',
  ) {
    if (isExhausted(model) && fallbackModel && !isExhausted(fallbackModel)) this.model = fallbackModel;
  }

  async complete(req: LLMRequest): Promise<string> {
    const parts: any[] = (req.images ?? []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } }));
    parts.push({ text: req.prompt });
    const isGemini3 = /gemini-3/i.test(this.model);
    const generationConfig: Record<string, unknown> = {
      responseMimeType: 'application/json',
      maxOutputTokens: req.maxTokens ?? 32768,
    };
    // Gemini 3: o Google recomenda manter a temperatura padrão (1.0); valores baixos causam repetição.
    if (!isGemini3) generationConfig.temperature = req.temperature ?? 0.4;
    if (isGemini3 && this.thinkingSupported) generationConfig.thinkingConfig = { thinkingLevel: this.thinkingLevel };

    const urlFor = () => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const body = { systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: 'user', parts }], generationConfig };

    const maxAttempts = this.free ? 6 : 4;
    for (let attempt = 1; ; attempt++) {
      if (this.free) {
        // ~8 chamadas/min: fica abaixo do limite por minuto do plano gratuito
        const wait = lastGeminiCall + 7500 - Date.now();
        if (wait > 0) await sleep(wait, req.signal);
        lastGeminiCall = Date.now();
      }
      try {
        const json = await postJson(urlFor(), body, { 'x-goog-api-key': this.apiKey }, req.signal);
        const um = json.usageMetadata ?? {};
        this.usage.calls++;
        this.usage.inputTokens += um.promptTokenCount ?? 0;
        this.usage.outputTokens += (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
        const cand = json.candidates?.[0];
        const text = cand?.content?.parts?.filter((p: any) => !p.thought).map((p: any) => p.text ?? '').join('') ?? '';
        if (!text) throw new Error(`Gemini sem resposta (${cand?.finishReason ?? json.promptFeedback?.blockReason ?? 'desconhecido'})`);
        return text;
      } catch (e) {
        if (req.signal?.aborted) throw e;
        if (e instanceof HttpError) {
          // Modelo sem suporte a thinkingLevel: repete sem o parâmetro
          if (e.status === 400 && /thinking/i.test(e.body) && this.thinkingSupported) {
            this.thinkingSupported = false;
            delete generationConfig.thinkingConfig;
            continue;
          }
          // Cota DIÁRIA esgotada: não adianta esperar minutos. Troca para o reserva ou falha na hora.
          if (e.status === 429 && /PerDay/i.test(e.body)) {
            exhaustedToday.set(this.model, today());
            if (this.fallbackModel && this.model !== this.fallbackModel && !isExhausted(this.fallbackModel)) {
              this.onNotice?.(`Cota diária de ${this.model} esgotada; usando o modelo reserva ${this.fallbackModel}`);
              this.model = this.fallbackModel;
              this.thinkingSupported = true;
              generationConfig.thinkingConfig = isGemini3 ? { thinkingLevel: this.thinkingLevel } : undefined;
              continue;
            }
            const secs = Number(/"retryDelay"\s*:\s*"(\d+)/.exec(e.body)?.[1] ?? 0);
            const when = secs ? ` (libera em ~${secs >= 3600 ? `${(secs / 3600).toFixed(1)} h` : `${Math.ceil(secs / 60)} min`})` : '';
            throw new Error(`Cota diária gratuita do Gemini esgotada para ${this.model}${when}. Ative o faturamento (plano "Pago") ou configure um modelo reserva.`);
          }
          const retryable = e.status === 429 || e.status >= 500;
          if (retryable && attempt < maxAttempts) {
            await sleep(retryDelayMs(e.body) ?? Math.min(60_000, 4000 * 2 ** (attempt - 1)), req.signal);
            continue;
          }
          if (e.status === 429) {
            throw new Error(
              this.free
                ? 'Limite do plano gratuito do Gemini atingido (por minuto ou por dia). Aguarde, ou ative o faturamento e mude o plano para "Pago" nas Configurações.'
                : `Limite de requisições do Gemini atingido: ${e.message}`,
            );
          }
          if (e.status === 404) throw new Error(`Modelo "${this.model}" não encontrado ou desativado. Use "Listar modelos" nas Configurações.`);
          if (e.status === 403 || e.status === 401) throw new Error(`Chave do Gemini recusada (${e.status}). Verifique a GEMINI_API_KEY.`);
        } else if (attempt < maxAttempts && (e instanceof TypeError || /fetch failed|ECONNRESET|ETIMEDOUT|socket|network|timeout/i.test(String((e as Error)?.message)))) {
          // Queda de rede / timeout: tenta de novo em vez de cair direto no plano heurístico
          await sleep(Math.min(30_000, 3000 * 2 ** (attempt - 1)), req.signal);
          continue;
        }
        throw e;
      }
    }
  }
}

/** Lê o "retryDelay" (ex.: "17s") que a API do Google devolve em erros 429. */
function retryDelayMs(body: string): number | null {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Math.min(90_000, Math.ceil(Number(m[1]) * 1000) + 500) : null;
}

class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  supportsImages = true;
  maxPromptChars = 400_000;
  free = false;
  usage: LLMUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  constructor(
    public model: string,
    private apiKey: string,
  ) {}
  async complete(req: LLMRequest): Promise<string> {
    const content: any[] = (req.images ?? []).map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.base64 } }));
    content.push({ type: 'text', text: req.prompt });
    const json = await postJson(
      'https://api.anthropic.com/v1/messages',
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 16000,
        temperature: req.temperature ?? 0.4,
        system: req.system,
        messages: [{ role: 'user', content }],
      },
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      req.signal,
    );
    this.usage.calls++;
    this.usage.inputTokens += json.usage?.input_tokens ?? 0;
    this.usage.outputTokens += json.usage?.output_tokens ?? 0;
    const text = (json.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    if (!text) throw new Error(`Anthropic sem resposta: ${JSON.stringify(json).slice(0, 300)}`);
    return text;
  }
}

class OllamaProvider implements LLMProvider {
  name = 'ollama';
  maxPromptChars = 24_000; // modelos locais costumam ter contexto de 8k tokens
  free = true;
  usage: LLMUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  supportsImages: boolean;
  constructor(
    public model: string,
    private baseUrl: string,
  ) {
    this.supportsImages = /llava|vision|gemma3|qwen2\.5vl|qwen2-vl|minicpm-v|moondream/i.test(model);
  }
  async complete(req: LLMRequest): Promise<string> {
    const json = await postJson(
      `${this.baseUrl.replace(/\/+$/, '')}/api/chat`,
      {
        model: this.model,
        stream: false,
        format: 'json',
        options: { temperature: req.temperature ?? 0.4, num_ctx: 8192 },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt, ...(this.supportsImages && req.images?.length ? { images: req.images.map((i) => i.base64) } : {}) },
        ],
      },
      {},
      req.signal,
    );
    this.usage.calls++;
    this.usage.inputTokens += json.prompt_eval_count ?? 0;
    this.usage.outputTokens += json.eval_count ?? 0;
    const text = json.message?.content ?? '';
    if (!text) throw new Error('Ollama sem resposta');
    return text;
  }
}

/** Qual modelo Gemini atende cada papel, conforme o plano escolhido. */
export function geminiModelFor(settings: AppSettings, role: LLMRole): string {
  if (role === 'select' && settings.geminiPlan === 'hybrid') return settings.geminiProModel || 'gemini-3.1-pro-preview';
  return settings.geminiFlashModel || 'gemini-3-flash-preview';
}

/**
 * Cria o provedor configurado para um papel (seleção de cortes, edição ou tradução).
 * Retorna null para o modo 'heuristic' (100% local, sem LLM).
 */
export function createLLM(settings: AppSettings, role: LLMRole = 'edit'): LLMProvider | null {
  switch (settings.aiProvider) {
    case 'gemini': {
      const key = getEnvValue('GEMINI_API_KEY');
      if (!key) throw new Error('GEMINI_API_KEY não configurada (Configurações ou .env.local)');
      return new GeminiProvider(geminiModelFor(settings, role), key, settings.geminiPlan === 'free', role === 'select' ? 'high' : 'low', settings.geminiFallbackModel);
    }
    case 'anthropic': {
      const key = getEnvValue('ANTHROPIC_API_KEY');
      if (!key) throw new Error('ANTHROPIC_API_KEY não configurada (Configurações ou .env.local)');
      return new AnthropicProvider(settings.anthropicModel || 'claude-sonnet-5-5', key);
    }
    case 'ollama': {
      const url = settings.ollamaUrl || 'http://127.0.0.1:11434';
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error(`URL do Ollama inválida: ${url}`);
      return new OllamaProvider(settings.ollamaModel || 'llama3', url);
    }
    default:
      return null;
  }
}

export function imageFromFile(file: string): LLMImage {
  return { mimeType: file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg', base64: fs.readFileSync(file).toString('base64') };
}

/** Teste rápido de conectividade (usado na tela de Configurações): testa cada modelo usado pelo plano. */
export async function pingLLM(settings: AppSettings): Promise<{ ok: boolean; message: string }> {
  try {
    const roles: LLMRole[] = settings.aiProvider === 'gemini' && settings.geminiPlan === 'hybrid' ? ['select', 'edit'] : ['edit'];
    const msgs: string[] = [];
    for (const role of roles) {
      const llm = createLLM(settings, role);
      if (!llm) return { ok: true, message: 'Modo heurístico local (sem LLM).' };
      const out = await llm.complete({ system: 'Responda apenas JSON.', prompt: 'Retorne {"ok":true}', maxTokens: 2000, temperature: 0 });
      if (!/ok/i.test(out)) return { ok: false, message: `${llm.model} respondeu algo inesperado: ${out.slice(0, 80)}` };
      msgs.push(`${llm.model} ✓`);
    }
    return { ok: true, message: `Conexão OK — ${msgs.join(' · ')}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Lista os modelos Gemini disponíveis para a chave configurada (endpoint ListModels). */
export async function listGeminiModels(): Promise<{ id: string; name: string }[]> {
  const key = getEnvValue('GEMINI_API_KEY');
  if (!key) throw new Error('Configure a GEMINI_API_KEY primeiro.');
  const out: { id: string; name: string }[] = [];
  let pageToken = '';
  for (let i = 0; i < 5; i++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20_000) });
    const json: any = await res.json();
    if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    for (const m of json.models ?? []) {
      if (!(m.supportedGenerationMethods ?? []).includes('generateContent')) continue;
      const id = String(m.name).replace(/^models\//, '');
      if (/^gemini-/.test(id) && !/tts|image|live|embedding|transcribe|audio/i.test(id)) out.push({ id, name: m.displayName ?? id });
    }
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}
