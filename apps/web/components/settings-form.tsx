'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, Cpu, KeyRound, Loader2, Plug, RefreshCw, Save, TriangleAlert, XCircle } from 'lucide-react';
import { DEFAULT_APP_SETTINGS, type AiProviderName, type AppSettings } from '@clipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/client';
import { cn } from '@/lib/utils';

type Secrets = Record<'GEMINI_API_KEY' | 'ANTHROPIC_API_KEY', boolean>;
interface EnvCheck {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
  required: boolean;
}

const PROVIDERS: { value: AiProviderName; label: string; desc: string }[] = [
  { value: 'heuristic', label: 'Heurístico local', desc: 'Sem LLM: pontuação por gatilhos, energia do áudio e estrutura das frases.' },
  { value: 'gemini', label: 'Google Gemini', desc: 'Multimodal (transcrição + frames). Requer GEMINI_API_KEY.' },
  { value: 'anthropic', label: 'Anthropic Claude', desc: 'Multimodal (transcrição + frames). Requer ANTHROPIC_API_KEY.' },
  { value: 'ollama', label: 'Ollama (local)', desc: 'LLM rodando na sua máquina (ex.: llama3). Sem custo, sem internet.' },
];

const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3'];

export function SettingsForm() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [secrets, setSecrets] = useState<Secrets>({ GEMINI_API_KEY: false, ANTHROPIC_API_KEY: false });
  const [keys, setKeys] = useState({ GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [env, setEnv] = useState<EnvCheck[] | null>(null);
  const [envLoading, setEnvLoading] = useState(false);

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  const loadEnv = async () => {
    setEnvLoading(true);
    try {
      setEnv((await api<{ checks: EnvCheck[] }>('/api/env')).checks);
    } finally {
      setEnvLoading(false);
    }
  };

  useEffect(() => {
    api<{ settings: AppSettings; secrets: Secrets }>('/api/settings').then((r) => {
      setSettings(r.settings);
      setSecrets(r.secrets);
    });
    loadEnv();
  }, []);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const secretsPatch = Object.fromEntries(Object.entries(keys).filter(([, v]) => v.trim()));
      const r = await api<{ settings: AppSettings; secrets: Secrets }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings, secrets: Object.keys(secretsPatch).length ? secretsPatch : undefined }),
      });
      setSettings(r.settings);
      setSecrets(r.secrets);
      setKeys({ GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '' });
      setMsg({ ok: true, text: 'Configurações salvas. Valem a partir do próximo job.' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function removeKey(k: keyof Secrets) {
    const r = await api<{ secrets: Secrets }>('/api/settings', { method: 'PUT', body: JSON.stringify({ secrets: { [k]: '' } }) });
    setSecrets(r.secrets);
  }

  async function test() {
    setTesting(true);
    setMsg(null);
    try {
      await save();
      const r = await api<{ ok: boolean; message: string }>('/api/settings/test', { method: 'POST' });
      setMsg({ ok: r.ok, text: r.message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="space-y-6 lg:col-span-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plug className="size-4 text-primary" /> Provedor de IA
            </CardTitle>
            <CardDescription>Usado na seleção de cortes, no plano de edição e na tradução. Se falhar, o app usa a heurística local.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              {PROVIDERS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => set('aiProvider', p.value)}
                  className={cn('rounded-lg border p-3 text-left transition-colors', settings.aiProvider === p.value ? 'border-primary bg-primary/10' : 'hover:bg-accent/40')}
                >
                  <div className="text-sm font-semibold">{p.label}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{p.desc}</div>
                </button>
              ))}
            </div>

            {settings.aiProvider === 'gemini' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Modelo Gemini">
                  <Input value={settings.geminiModel} onChange={(e) => set('geminiModel', e.target.value)} />
                </Field>
                <KeyField name="GEMINI_API_KEY" configured={secrets.GEMINI_API_KEY} value={keys.GEMINI_API_KEY} onChange={(v) => setKeys((k) => ({ ...k, GEMINI_API_KEY: v }))} onRemove={() => removeKey('GEMINI_API_KEY')} />
              </div>
            )}
            {settings.aiProvider === 'anthropic' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Modelo Claude">
                  <Input value={settings.anthropicModel} onChange={(e) => set('anthropicModel', e.target.value)} />
                </Field>
                <KeyField name="ANTHROPIC_API_KEY" configured={secrets.ANTHROPIC_API_KEY} value={keys.ANTHROPIC_API_KEY} onChange={(v) => setKeys((k) => ({ ...k, ANTHROPIC_API_KEY: v }))} onRemove={() => removeKey('ANTHROPIC_API_KEY')} />
              </div>
            )}
            {settings.aiProvider === 'ollama' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="URL do Ollama">
                  <Input value={settings.ollamaUrl} onChange={(e) => set('ollamaUrl', e.target.value)} />
                </Field>
                <Field label="Modelo">
                  <Input value={settings.ollamaModel} onChange={(e) => set('ollamaModel', e.target.value)} placeholder="llama3" />
                </Field>
              </div>
            )}
            {settings.aiProvider !== 'heuristic' && settings.aiProvider !== 'ollama' && (
              <p className="text-xs text-muted-foreground">As chaves ficam em <code>.env.local</code> na raiz do projeto e nunca são enviadas ao navegador.</p>
            )}
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <span className="text-sm">Enviar frames amostrados para a IA (contexto visual)</span>
              <Switch checked={settings.sendFramesToAI} onCheckedChange={(v) => set('sendFramesToAI', v)} />
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="size-4 text-primary" /> Processamento
            </CardTitle>
            <CardDescription>Transcrição (faster-whisper) e renderização (FFmpeg).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field label="Modelo Whisper" hint="small: bom equilíbrio. medium/large: mais preciso e mais lento.">
              <Select value={settings.whisperModel} onChange={(e) => set('whisperModel', e.target.value)}>
                {WHISPER_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Dispositivo Whisper" hint="Auto tenta CUDA e cai para CPU se falhar.">
              <Select value={settings.whisperDevice} onChange={(e) => set('whisperDevice', e.target.value as AppSettings['whisperDevice'])}>
                <option value="auto">Auto (GPU → CPU)</option>
                <option value="cuda">GPU (CUDA)</option>
                <option value="cpu">CPU</option>
              </Select>
            </Field>
            <Field label="Threads de processamento">
              <Input type="number" min={1} max={64} value={settings.threads} onChange={(e) => set('threads', Number(e.target.value) || 4)} />
            </Field>
            <Field label="Acelerador gráfico (encode)" hint="NVENC usa a GPU NVIDIA; volta para x264 se falhar.">
              <Select value={settings.hwAccel} onChange={(e) => set('hwAccel', e.target.value as AppSettings['hwAccel'])}>
                <option value="none">CPU (libx264)</option>
                <option value="nvenc">NVIDIA NVENC</option>
              </Select>
            </Field>
          </CardContent>
        </Card>

        {msg && (
          <p className={cn('flex items-start gap-2 rounded-md px-3 py-2 text-sm', msg.ok ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')}>
            {msg.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
            <span className="break-all">{msg.text}</span>
          </p>
        )}
        <div className="flex gap-2">
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />} Salvar
          </Button>
          <Button variant="outline" onClick={test} disabled={testing}>
            {testing ? <Loader2 className="animate-spin" /> : <Plug />} Salvar e testar IA
          </Button>
        </div>
      </div>

      <Card className="h-fit lg:col-span-2">
        <CardHeader className="flex-row items-start justify-between">
          <div className="space-y-1">
            <CardTitle>Ambiente local</CardTitle>
            <CardDescription>Resultado de scripts/check-env.js</CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={loadEnv} disabled={envLoading}>
            <RefreshCw className={cn(envLoading && 'animate-spin')} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {!env && <p className="text-sm text-muted-foreground">Verificando…</p>}
          {env?.map((c) => (
            <div key={c.name} className="flex items-start gap-2 text-sm">
              {c.ok ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
              ) : c.required ? (
                <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              ) : (
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              )}
              <div className="min-w-0">
                <div className="font-medium">{c.name}</div>
                <div className="truncate text-xs text-muted-foreground" title={c.detail}>
                  {c.detail}
                </div>
                {!c.ok && c.hint && <div className="text-xs text-warning">{c.hint}</div>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function KeyField({ name, configured, value, onChange, onRemove }: { name: string; configured: boolean; value: string; onChange: (v: string) => void; onRemove: () => void }) {
  return (
    <Field label={name}>
      <div className="flex gap-2">
        <Input type="password" autoComplete="off" placeholder={configured ? '•••••••• (configurada)' : 'cole a chave aqui'} value={value} onChange={(e) => onChange(e.target.value)} />
        {configured && (
          <Button variant="ghost" size="icon" className="h-9 w-9" title="Remover chave" onClick={onRemove}>
            <KeyRound />
          </Button>
        )}
      </div>
    </Field>
  );
}
