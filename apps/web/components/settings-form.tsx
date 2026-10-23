'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, Cpu, ImageIcon, KeyRound, Loader2, PenLine, Plug, RefreshCw, Save, Sparkles, TriangleAlert, XCircle } from 'lucide-react';
import { DEFAULT_APP_SETTINGS, LANGUAGES, type AiProviderName, type AppSettings, type GeminiPlan } from '@clipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/client';
import { cn } from '@/lib/utils';

type SecretName = 'GEMINI_API_KEY' | 'ANTHROPIC_API_KEY' | 'PIXABAY_API_KEY' | 'TMDB_API_KEY';
type Secrets = Record<SecretName, boolean>;
const NO_SECRETS: Secrets = { GEMINI_API_KEY: false, ANTHROPIC_API_KEY: false, PIXABAY_API_KEY: false, TMDB_API_KEY: false };
const EMPTY_KEYS: Record<SecretName, string> = { GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', PIXABAY_API_KEY: '', TMDB_API_KEY: '' };
interface EnvCheck {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
  required: boolean;
}

const PROVIDERS: { value: AiProviderName; label: string; desc: string }[] = [
  { value: 'heuristic', label: 'Heurístico local', desc: 'Sem LLM: pontuação por gatilhos, energia do áudio e estrutura das frases.' },
  { value: 'gemini', label: 'Google Gemini', desc: 'Gemini 3 Flash / Pro, multimodal (transcrição + frames). Tem plano gratuito.' },
  { value: 'anthropic', label: 'Anthropic Claude', desc: 'Multimodal (transcrição + frames). Requer ANTHROPIC_API_KEY.' },
  { value: 'ollama', label: 'Ollama (local)', desc: 'LLM rodando na sua máquina (ex.: llama3). Sem custo, sem internet.' },
];

const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3'];

export function SettingsForm() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [secrets, setSecrets] = useState<Secrets>(NO_SECRETS);
  const [keys, setKeys] = useState(EMPTY_KEYS);
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
      setKeys(EMPTY_KEYS);
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
              <GeminiSection
                settings={settings}
                set={set}
                keyField={
                  <KeyField name="GEMINI_API_KEY" configured={secrets.GEMINI_API_KEY} value={keys.GEMINI_API_KEY} onChange={(v) => setKeys((k) => ({ ...k, GEMINI_API_KEY: v }))} onRemove={() => removeKey('GEMINI_API_KEY')} />
                }
                keyConfigured={secrets.GEMINI_API_KEY}
              />
            )}
            {settings.aiProvider === 'anthropic' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Modelo que escolhe os cortes (o mais capaz)">
                  <Input value={settings.anthropicSelectModel} onChange={(e) => set('anthropicSelectModel', e.target.value)} placeholder="claude-opus-5-5" />
                </Field>
                <Field label="Modelo de edição, títulos e tradução">
                  <Input value={settings.anthropicModel} onChange={(e) => set('anthropicModel', e.target.value)} placeholder="claude-sonnet-5-5" />
                </Field>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Opus 5.5 (US$ 4 / 20 por 1M tokens) pensa a seleção com calma; Sonnet 5.5 (US$ 2 / 10) faz o resto. Um vídeo de 10–30 min costuma custar entre US$ 0,20 e 1,00 (o custo estimado aparece no log de cada job).
                </p>
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
              <PenLine className="size-4 text-primary" /> Diretrizes editoriais da IA
            </CardTitle>
            <CardDescription>
              Explique como a IA deve pensar: que trechos escolher, o estilo da edição, quando usar memes e sons, quais palavras destacar e o tom dos títulos e hashtags. Vale para
              seleção, edição e tradução.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <textarea
              value={settings.editingPrompt}
              onChange={(e) => set('editingPrompt', e.target.value)}
              rows={10}
              maxLength={6000}
              placeholder="Ex.: Meu canal é de finanças para jovens. Priorize trechos com números concretos e histórias pessoais…"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => set('editingPrompt', EXAMPLE_PROMPT)} disabled={!!settings.editingPrompt.trim()}>
                Inserir exemplo
              </Button>
              <span className="text-xs text-muted-foreground">{settings.editingPrompt.length}/6000</span>
            </div>
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <span className="text-sm">
                Gerar sempre o texto em português do que é falado
                <span className="block text-xs text-muted-foreground">Só texto (transcricao_pt.txt), feito uma vez por vídeo e guardado em cache.</span>
              </span>
              <Switch checked={settings.ptTranscript} onCheckedChange={(v) => set('ptTranscript', v)} />
            </label>
            <Field label="Idioma dos títulos, legendas de post e hashtags">
              <Select value={settings.postLanguage} onChange={(e) => set('postLanguage', e.target.value)}>
                <option value="">Mesmo idioma do vídeo</option>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-xs text-muted-foreground">
              Sem provedor de IA (modo heurístico) este texto não é usado. Limites técnicos (quantidade de memes por intensidade, tempos válidos) continuam sendo aplicados.
            </p>
          </CardContent>
        </Card>

        <ReferencesCard enabled={settings.useReferences} onToggle={(v) => set('useReferences', v)} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ImageIcon className="size-4 text-primary" /> Ilustrações automáticas
            </CardTitle>
            <CardDescription>
              Quando a pessoa fala de algo concreto (um avião, um filme, um jogador), a IA pede uma imagem e o app busca em bancos de licença livre: Wikimedia Commons e
              Openverse (sem chave), Pixabay e TMDB (filmes e séries, chave grátis). Fotos sem fundo transparente viram um cartão com borda.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <span className="text-sm">Ilustrar o que é falado</span>
              <Switch checked={settings.useIllustrations} onCheckedChange={(v) => set('useIllustrations', v)} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <KeyField name="PIXABAY_API_KEY" configured={secrets.PIXABAY_API_KEY} value={keys.PIXABAY_API_KEY} onChange={(v) => setKeys((k) => ({ ...k, PIXABAY_API_KEY: v }))} onRemove={() => removeKey('PIXABAY_API_KEY')} />
              <KeyField name="TMDB_API_KEY" configured={secrets.TMDB_API_KEY} value={keys.TMDB_API_KEY} onChange={(v) => setKeys((k) => ({ ...k, TMDB_API_KEY: v }))} onRemove={() => removeKey('TMDB_API_KEY')} />
            </div>
            <p className="text-xs text-muted-foreground">
              Chaves grátis: pixabay.com/api/docs e themoviedb.org/settings/api. Imagens com licença que pede crédito entram no fim da descrição do post.
            </p>
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
            <Field label="Legenda antiga do vídeo original" hint="Recortar fora: enquadra sem a faixa da legenda (imagem 100% real). Apagar: remove o texto e preenche (pode deixar marcas).">
              <Select value={settings.subtitleRemoval} onChange={(e) => set('subtitleRemoval', e.target.value as AppSettings['subtitleRemoval'])}>
                <option value="crop">Recortar fora do quadro (recomendado)</option>
                <option value="inpaint">Apagar e preencher</option>
              </Select>
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

const EXAMPLE_PROMPT = `PÚBLICO E OBJETIVO
- Canal de [tema] para [público]. Objetivo: reter até o fim e gerar compartilhamento.

ESCOLHA DOS CORTES
- Comece sempre por uma frase forte: pergunta, número, opinião polêmica ou promessa.
- Prefira histórias com começo, meio e fim e trechos com conselhos práticos.
- Evite trechos que dependem de contexto anterior ou citam "como eu falei antes".

ESTILO DA EDIÇÃO
- Zoom nas frases de impacto e nas revelações; mantenha o rosto visível.
- Memes de reação só em momentos realmente engraçados ou surpreendentes, nunca em assuntos sérios.
- Sons de impacto nas revelações, risadas apenas em piadas, whoosh nas mudanças de assunto.

PALAVRAS EM DESTAQUE
- Destaque números, valores em dinheiro, nomes próprios e palavras como "nunca", "segredo", "erro".

TÍTULOS E HASHTAGS
- Títulos curtos, em tom de conversa, que gerem curiosidade sem mentir (nada de clickbait falso).
- Hashtags em português, misturando gerais (#dinheiro) e de nicho (#educacaofinanceira).`;

const GEMINI_PLANS: { value: GeminiPlan; label: string; cost: string; desc: string }[] = [
  { value: 'free', label: 'Gratuito', cost: 'US$ 0', desc: 'Só Flash, no plano gratuito do AI Studio. Ideal para testar. Tem limite de chamadas por minuto/dia.' },
  { value: 'paid', label: 'Pago (Flash)', cost: '~US$ 10–25/mês', desc: 'Faturamento ativo, só Flash. Sem espera entre chamadas. Para postar em escala.' },
  { value: 'hybrid', label: 'Combinado (Pro + Flash)', cost: '~US$ 30–60/mês', desc: 'Pro escolhe os cortes; Flash faz edição, memes, sons, títulos, hashtags e tradução.' },
];

function GeminiSection({
  settings,
  set,
  keyField,
  keyConfigured,
}: {
  settings: AppSettings;
  set: <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => void;
  keyField: React.ReactNode;
  keyConfigured: boolean;
}) {
  const [models, setModels] = useState<{ id: string; name: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadModels() {
    setLoading(true);
    setError(null);
    try {
      setModels((await api<{ models: { id: string; name: string }[] }>('/api/settings/gemini-models')).models);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-3">
      {keyField}
      <div className="space-y-1.5">
        <Label>Plano de uso</Label>
        <div className="grid gap-2 sm:grid-cols-3">
          {GEMINI_PLANS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => set('geminiPlan', p.value)}
              className={cn('rounded-lg border p-3 text-left transition-colors', settings.geminiPlan === p.value ? 'border-primary bg-primary/10' : 'hover:bg-accent/40')}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">{p.label}</span>
                <span className="text-[11px] text-muted-foreground">{p.cost}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{p.desc}</div>
            </button>
          ))}
        </div>
        {settings.geminiPlan === 'free' && (
          <p className="text-xs text-warning">
            No plano gratuito o Google pode usar os dados enviados (transcrições e frames) para melhorar os produtos dele. O app espaça as chamadas (~8/min) e tenta de novo quando o limite é
            atingido.
          </p>
        )}
        {settings.geminiPlan !== 'free' && (
          <p className="text-xs text-muted-foreground">Requer faturamento ativo no projeto do Google AI Studio da sua chave. Valores mensais são estimativas para ~3 vídeos por dia.</p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Modelo Flash (edição, títulos, tradução)" hint={settings.geminiPlan === 'hybrid' ? undefined : 'Também escolhe os cortes nos planos Gratuito e Pago.'}>
          <Input list="gemini-models" value={settings.geminiFlashModel} onChange={(e) => set('geminiFlashModel', e.target.value.trim())} />
        </Field>
        <Field label="Modelo Pro (escolha dos cortes)" hint={settings.geminiPlan === 'hybrid' ? 'Sem plano gratuito no Google.' : 'Usado só no plano Combinado.'}>
          <Input list="gemini-models" value={settings.geminiProModel} onChange={(e) => set('geminiProModel', e.target.value.trim())} disabled={settings.geminiPlan !== 'hybrid'} />
        </Field>
        <Field label="Modelo reserva (cota diária esgotada)" hint="Usado automaticamente quando o limite diário do modelo principal acaba. Vazio = nenhum.">
          <Input list="gemini-models" value={settings.geminiFallbackModel} onChange={(e) => set('geminiFallbackModel', e.target.value.trim())} placeholder="gemini-3.1-flash-lite" />
        </Field>
      </div>
      <datalist id="gemini-models">
        {models?.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </datalist>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={loadModels} disabled={loading || !keyConfigured}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Listar modelos disponíveis
        </Button>
        {!keyConfigured && <span className="text-xs text-muted-foreground">Salve a chave para listar.</span>}
        {models && <span className="text-xs text-muted-foreground">{models.length} modelos — escolha nos campos acima.</span>}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </div>
  );
}

interface RefsResponse {
  dir: string;
  references: { name: string; analyzed: boolean; niche: string | null; stats: Record<string, number> | null }[];
  guide: string | null;
}

/** Clipes virais de referência → guia de estilo usado pela IA. */
function ReferencesCard({ enabled, onToggle }: { enabled: boolean; onToggle: (v: boolean) => void }) {
  const [data, setData] = useState<RefsResponse | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api<RefsResponse>('/api/references').then(setData).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  async function analyze() {
    setMsg(null);
    try {
      await api('/api/references', { method: 'POST' });
      setMsg('Análise na fila. Acompanhe no Painel; ao terminar, clique em atualizar aqui.');
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  const pending = data?.references.filter((r) => !r.analyzed).length ?? 0;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" /> Clipes de referência (estilo)
          </CardTitle>
          <CardDescription>
            Coloque cortes virais do seu nicho em <code className="break-all">{data?.dir ?? 'data/references'}</code>. Cada um é analisado uma vez e vira um guia de estilo que a IA segue
            (gancho, ritmo, tipo de momento, memes, final).
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={load} title="Atualizar">
          <RefreshCw />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
          <span className="text-sm">Seguir o guia de estilo das referências</span>
          <Switch checked={enabled} onCheckedChange={onToggle} />
        </label>
        {data && (
          <ul className="space-y-1 text-xs">
            {data.references.map((r) => (
              <li key={r.name} className="flex items-center gap-2">
                {r.analyzed ? <CheckCircle2 className="size-3.5 shrink-0 text-success" /> : <TriangleAlert className="size-3.5 shrink-0 text-warning" />}
                <span className="truncate" title={r.name}>
                  {r.name}
                </span>
                {r.niche && <span className="truncate text-muted-foreground">— {r.niche}</span>}
              </li>
            ))}
            {!data.references.length && <li className="text-muted-foreground">Nenhum clipe na pasta ainda.</li>}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={analyze} disabled={!data?.references.length}>
            <Sparkles /> Analisar agora{pending ? ` (${pending} novo${pending > 1 ? 's' : ''})` : ''}
          </Button>
          <span className="text-xs text-muted-foreground">Clipes novos também são analisados automaticamente no próximo processamento.</span>
        </div>
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
        {data?.guide && (
          <details className="rounded-md border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Guia de estilo atual</summary>
            <pre className="max-h-80 overflow-auto border-t px-3 py-2 font-sans text-xs leading-relaxed whitespace-pre-wrap">{data.guide}</pre>
          </details>
        )}
      </CardContent>
    </Card>
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
