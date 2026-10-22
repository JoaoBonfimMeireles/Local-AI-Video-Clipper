'use client';
import { useEffect, useRef, useState } from 'react';
import { FileVideo, Loader2, Play, RefreshCw, Save, Trash2, UploadCloud } from 'lucide-react';
import { creditLine, DEFAULT_JOB_SETTINGS, formatBytes, LANGUAGES, type Intensity, type JobSettings, type OutputFormat, type Preset } from '@clipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api, uploadFile } from '@/lib/client';
import { cn } from '@/lib/utils';

interface InputFile {
  name: string;
  size: number;
}

const INTENSITIES: { value: Intensity; label: string; desc: string }[] = [
  { value: 'low', label: 'Baixa', desc: 'Cortes limpos, legenda discreta, quase sem efeitos' },
  { value: 'medium', label: 'Média', desc: 'Legenda dinâmica, zooms pontuais, memes em picos' },
  { value: 'high', label: 'Alta', desc: 'Ritmo acelerado, zoom constante, muitos memes e sons' },
];

const FORMATS: { value: OutputFormat; label: string; desc: string; ratio: string }[] = [
  { value: 'vertical_blur', label: 'Vertical 9:16', desc: 'fundo desfocado', ratio: 'aspect-[9/16] h-10' },
  { value: 'vertical_crop', label: 'Vertical 9:16', desc: 'recorte central', ratio: 'aspect-[9/16] h-10' },
  { value: 'square', label: 'Quadrado 1:1', desc: 'fundo desfocado', ratio: 'aspect-square h-8' },
  { value: 'original', label: 'Original', desc: 'preserva 16:9', ratio: 'aspect-video h-6' },
];

export function NewJobForm({ onCreated }: { onCreated: () => void }) {
  const [settings, setSettings] = useState<JobSettings>(DEFAULT_JOB_SETTINGS);
  const [files, setFiles] = useState<InputFile[]>([]);
  const [selected, setSelected] = useState('');
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof JobSettings>(k: K, v: JobSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  async function loadFiles(select?: string) {
    const r = await api<{ files: InputFile[] }>('/api/inputs');
    setFiles(r.files);
    if (select) setSelected(select);
    else if (!selected && r.files[0]) setSelected(r.files[0].name);
  }
  async function loadPresets() {
    setPresets((await api<{ presets: Preset[] }>('/api/presets')).presets);
  }
  useEffect(() => {
    loadFiles().catch(() => undefined);
    loadPresets().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFiles(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    setMessage(null);
    setUpload({ name: file.name, progress: 0 });
    try {
      const r = await uploadFile(file, (p) => setUpload({ name: file.name, progress: p }));
      await loadFiles(r.name);
      setMessage({ type: 'ok', text: `"${r.name}" enviado para data/input` });
    } catch (e) {
      setMessage({ type: 'error', text: (e as Error).message });
    } finally {
      setUpload(null);
    }
  }

  function applyPreset(id: string) {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    if (p) {
      // Créditos pertencem ao vídeo, não ao estilo: o preset não os sobrescreve
      setSettings((cur) => ({ ...DEFAULT_JOB_SETTINGS, ...p.settings, creditTitle: cur.creditTitle, creditChannel: cur.creditChannel, creditUrl: cur.creditUrl }));
      setPresetName(p.builtin ? '' : p.name);
    }
  }

  async function savePreset() {
    if (!presetName.trim()) return;
    try {
      const r = await api<{ preset: Preset }>('/api/presets', { method: 'POST', body: JSON.stringify({ name: presetName.trim(), settings }) });
      await loadPresets();
      setPresetId(r.preset.id);
      setMessage({ type: 'ok', text: `Perfil "${r.preset.name}" salvo` });
    } catch (e) {
      setMessage({ type: 'error', text: (e as Error).message });
    }
  }

  async function deletePreset() {
    if (!presetId) return;
    await api(`/api/presets/${presetId}`, { method: 'DELETE' }).catch(() => undefined);
    setPresetId('');
    await loadPresets();
  }

  async function submit() {
    if (!selected) return setMessage({ type: 'error', text: 'Selecione ou envie um vídeo.' });
    setSubmitting(true);
    setMessage(null);
    try {
      await api('/api/jobs', { method: 'POST', body: JSON.stringify({ inputFile: selected, settings }) });
      setMessage({ type: 'ok', text: 'Job adicionado à fila!' });
      onCreated();
    } catch (e) {
      setMessage({ type: 'error', text: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  const currentPreset = presets.find((p) => p.id === presetId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Novo processamento</CardTitle>
        <CardDescription>Envie um vídeo longo e defina os parâmetros editoriais.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 1. Vídeo */}
        <section className="space-y-3">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFiles(e.dataTransfer.files);
            }}
            onClick={() => !upload && fileInput.current?.click()}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
              dragging ? 'border-primary bg-primary/10' : 'hover:border-primary/60 hover:bg-accent/40',
            )}
          >
            {upload ? (
              <div className="w-full max-w-sm space-y-2">
                <p className="truncate text-sm">Enviando {upload.name}…</p>
                <Progress value={upload.progress * 100} />
                <p className="text-xs text-muted-foreground">{(upload.progress * 100).toFixed(0)}%</p>
              </div>
            ) : (
              <>
                <UploadCloud className="size-8 text-primary" />
                <p className="text-sm font-medium">Arraste um vídeo aqui ou clique para escolher</p>
                <p className="text-xs text-muted-foreground">MP4, MOV, MKV, WEBM… (vídeos longos de 30min+ são suportados)</p>
              </>
            )}
            <input ref={fileInput} type="file" accept="video/*,.mkv" className="hidden" onChange={(e) => handleFiles(e.target.files)} />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label>Ou selecione de data/input</Label>
              <Select value={selected} onChange={(e) => setSelected(e.target.value)}>
                {!files.length && <option value="">Nenhum vídeo em data/input</option>}
                {files.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name} ({formatBytes(f.size)})
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => loadFiles()} title="Atualizar lista">
              <RefreshCw />
            </Button>
          </div>
        </section>

        {/* Perfis */}
        <section className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
          <Label>Perfil de edição (preset)</Label>
          <div className="flex flex-wrap gap-2">
            <Select value={presetId} onChange={(e) => applyPreset(e.target.value)} className="min-w-48 flex-1">
              <option value="">— Personalizado —</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.builtin ? '★ ' : ''}
                  {p.name}
                </option>
              ))}
            </Select>
            <Input placeholder="Nome para salvar" value={presetName} onChange={(e) => setPresetName(e.target.value)} className="w-44" />
            <Button variant="secondary" onClick={savePreset} disabled={!presetName.trim()}>
              <Save /> Salvar
            </Button>
            {currentPreset && !currentPreset.builtin && (
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={deletePreset} title="Excluir perfil">
                <Trash2 />
              </Button>
            )}
          </div>
        </section>

        {/* 2 e 3. Duração e quantidade */}
        <section className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Duração média dos cortes (s)</Label>
            <div className="flex flex-wrap gap-2">
              <Input type="number" min={10} max={600} value={settings.targetDuration} onChange={(e) => set('targetDuration', Number(e.target.value) || 60)} className="w-24" />
              {[30, 60, 120, 180].map((d) => (
                <Button key={d} type="button" size="sm" variant={settings.targetDuration === d ? 'default' : 'outline'} className="h-9" onClick={() => set('targetDuration', d)}>
                  {d}s
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Referência flexível: a IA respeita o fim das frases.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Quantidade de cortes</Label>
            <div className="flex items-center gap-3">
              <Button type="button" size="sm" className="h-9" variant={settings.maxClips === 'auto' ? 'default' : 'outline'} onClick={() => set('maxClips', 'auto')}>
                Automático
              </Button>
              <Input
                type="number"
                min={1}
                max={50}
                placeholder="máx."
                value={settings.maxClips === 'auto' ? '' : settings.maxClips}
                onChange={(e) => set('maxClips', e.target.value ? Math.max(1, Number(e.target.value)) : 'auto')}
                className="w-24"
              />
            </div>
            <p className="text-xs text-muted-foreground">Automático: só entram trechos realmente bons.</p>
          </div>
        </section>

        {/* 4. Intensidade */}
        <section className="space-y-1.5">
          <Label>Intensidade da edição</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            {INTENSITIES.map((i) => (
              <button
                key={i.value}
                type="button"
                onClick={() => set('intensity', i.value)}
                className={cn('rounded-lg border p-3 text-left transition-colors', settings.intensity === i.value ? 'border-primary bg-primary/10' : 'hover:bg-accent/40')}
              >
                <div className="text-sm font-semibold">{i.label}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{i.desc}</div>
              </button>
            ))}
          </div>
        </section>

        {/* 5. Formato */}
        <section className="space-y-1.5">
          <Label>Formato de saída</Label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {FORMATS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => set('format', f.value)}
                className={cn('flex flex-col items-center gap-2 rounded-lg border p-3 transition-colors', settings.format === f.value ? 'border-primary bg-primary/10' : 'hover:bg-accent/40')}
              >
                <div className="flex h-10 items-center">
                  <div className={cn('rounded-sm border-2 border-current opacity-70', f.ratio)} />
                </div>
                <div className="text-center">
                  <div className="text-xs font-semibold">{f.label}</div>
                  <div className="text-[11px] text-muted-foreground">{f.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* 6. Legendas */}
        <section className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Idioma original</Label>
            <Select value={settings.sourceLanguage} onChange={(e) => set('sourceLanguage', e.target.value)}>
              <option value="auto">Detectar automaticamente (Whisper)</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Traduzir legendas para</Label>
            <Select value={settings.translateTo} onChange={(e) => set('translateTo', e.target.value)}>
              <option value="">Não traduzir</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
            {settings.translateTo && <p className="text-xs text-muted-foreground">Requer Gemini, Anthropic ou Ollama nas Configurações.</p>}
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <Toggle label="Incorporar legendas no MP4" checked={settings.burnSubtitles} onChange={(v) => set('burnSubtitles', v)} />
          <Toggle label="Exportar arquivos .srt" checked={settings.exportSrt} onChange={(v) => set('exportSrt', v)} />
          <Toggle label="Usar memes da biblioteca" checked={settings.useMemes} onChange={(v) => set('useMemes', v)} />
          <Toggle label="Usar efeitos sonoros" checked={settings.useSfx} onChange={(v) => set('useSfx', v)} />
          <Toggle label="Remover legenda do vídeo original" checked={settings.removeOldSubtitles} onChange={(v) => set('removeOldSubtitles', v)} />
        </section>

        {/* Créditos (vídeos Creative Commons) */}
        <section className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <div>
            <Label>Créditos do vídeo original</Label>
            <p className="mt-1 text-xs text-muted-foreground">Para vídeos do YouTube com licença Creative Commons: o crédito é adicionado ao fim da descrição de cada corte.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="Título do vídeo original" value={settings.creditTitle} onChange={(e) => set('creditTitle', e.target.value)} maxLength={300} />
            <Input placeholder="Canal / autor" value={settings.creditChannel} onChange={(e) => set('creditChannel', e.target.value)} maxLength={200} />
          </div>
          <Input placeholder="https://www.youtube.com/watch?v=..." value={settings.creditUrl} onChange={(e) => set('creditUrl', e.target.value.trim())} type="url" />
          {creditLine(settings) && <p className="rounded-md bg-background/60 p-2 text-xs text-muted-foreground">{creditLine(settings)}</p>}
        </section>

        {message && <p className={cn('rounded-md px-3 py-2 text-sm', message.type === 'ok' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')}>{message.text}</p>}

        <Button size="lg" className="w-full" onClick={submit} disabled={submitting || !selected || !!upload}>
          {submitting ? <Loader2 className="animate-spin" /> : <Play />}
          Iniciar processamento
          {selected && (
            <span className="ml-1 flex min-w-0 items-center gap-1 truncate text-xs opacity-80">
              <FileVideo className="size-3" />
              {selected}
            </span>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
      <span className="text-sm">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}
