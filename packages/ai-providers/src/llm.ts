import fs from 'node:fs';
import type { AppSettings } from '@clipper/shared';
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

export interface LLMProvider {
  name: string;
  model: string;
  supportsImages: boolean;
  /** Tamanho máximo de transcrição por chamada (caracteres); acima disso o texto é dividido. */
  maxPromptChars: number;
  complete(req: LLMRequest): Promise<string>;
}

const TIMEOUT_MS = 5 * 60_000;

function withTimeout(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: withTimeout(signal),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} de ${new URL(url).host}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

class GeminiProvider implements LLMProvider {
  name = 'gemini';
  supportsImages = true;
  maxPromptChars = 600_000;
  constructor(
    public model: string,
    private apiKey: string,
  ) {}
  async complete(req: LLMRequest): Promise<string> {
    const parts: any[] = (req.images ?? []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } }));
    parts.push({ text: req.prompt });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const json = await postJson(
      url,
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: req.temperature ?? 0.4, maxOutputTokens: req.maxTokens ?? 16384 },
      },
      { 'x-goog-api-key': this.apiKey },
      req.signal,
    );
    const text = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    if (!text) throw new Error(`Gemini sem resposta: ${JSON.stringify(json).slice(0, 300)}`);
    return text;
  }
}

class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  supportsImages = true;
  maxPromptChars = 400_000;
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
    const text = (json.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    if (!text) throw new Error(`Anthropic sem resposta: ${JSON.stringify(json).slice(0, 300)}`);
    return text;
  }
}

class OllamaProvider implements LLMProvider {
  name = 'ollama';
  maxPromptChars = 24_000; // modelos locais costumam ter contexto de 8k tokens
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
    const text = json.message?.content ?? '';
    if (!text) throw new Error('Ollama sem resposta');
    return text;
  }
}

/** Cria o provedor configurado. Retorna null para o modo 'heuristic' (100% local, sem LLM). */
export function createLLM(settings: AppSettings): LLMProvider | null {
  switch (settings.aiProvider) {
    case 'gemini': {
      const key = getEnvValue('GEMINI_API_KEY');
      if (!key) throw new Error('GEMINI_API_KEY não configurada (Configurações ou .env.local)');
      return new GeminiProvider(settings.geminiModel || 'gemini-2.5-flash', key);
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

/** Teste rápido de conectividade (usado na tela de Configurações). */
export async function pingLLM(settings: AppSettings): Promise<{ ok: boolean; message: string }> {
  try {
    const llm = createLLM(settings);
    if (!llm) return { ok: true, message: 'Modo heurístico local (sem LLM).' };
    const out = await llm.complete({ system: 'Responda apenas JSON.', prompt: 'Retorne {"ok":true}', maxTokens: 50, temperature: 0 });
    return { ok: /ok/i.test(out), message: `${llm.name}/${llm.model} respondeu: ${out.slice(0, 80)}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
