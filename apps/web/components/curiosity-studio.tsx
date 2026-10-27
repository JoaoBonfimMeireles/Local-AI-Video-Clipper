'use client';
// Canal de curiosidades: vídeo-fonte → a IA sugere ideias pelos formatos da biblioteca → o editor escolhe,
// ajusta os trechos à mão (com prévia vertical e narrador) → cada ideia aprovada vira um vídeo curto.
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check, Clock, Film, Loader2, Mic, MicOff, Pause, Play, Plus, RefreshCw, Scissors, Sparkles, Trash2, UploadCloud, Wand2 } from 'lucide-react';
import {
  CURIOSITY_TEMPLATES,
  curiosityTemplate,
  DEFAULT_JOB_SETTINGS,
  formatBytes,
  formatTimestamp,
  type CuriosityAnalysis,
  type CuriosityIdea,
  type CuriosityTemplateKey,
  type Job,
  type OutputFormat,
} from '@clipper/shared';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { JobStatusBadge, stepLabel } from '@/components/job-status';
import { NarratorAvatar } from '@/components/narrator-avatar';
import { api, fileUrl, uploadFile, usePolling } from '@/lib/client';
import { cn } from '@/lib/utils';
import { SpeedPicker } from '@/components/speed-picker';

interface InputFile {
  name: string;
  size: number;
}
interface Overview {
  sources: { job: Job; ideas: number; summary: string }[];
  renders: Job[];
}

const ideaDuration = (i: CuriosityIdea) => i.segments.reduce((a, s) => a + (s.end - s.start), 0);
/** Duração falada estimada do roteiro (~2,6 palavras/s na voz do narrador). */
const speechSeconds = (text: string) => text.trim().split(/\s+/).filter(Boolean).length / 2.6;
const gradient = (key: string) => {
  const t = curiosityTemplate(key);
  return `linear-gradient(135deg, ${t.from}, ${t.to})`;
};

export function CuriosityStudio() {
  const params = useSearchParams();
  const router = useRouter();
  const sourceId = params.get('fonte');
  const { data: overview, refresh } = usePolling(() => api<Overview>('/api/curiosities'), 2000);

  return (
    <div className="space-y-8 pb-28">
      <Hero />
      <NewSource onCreated={(id) => (refresh(), router.push(`/curiosidades?fonte=${id}`))} />
      <SourcesStrip overview={overview} current={sourceId} />
      {sourceId && <IdeaGallery key={sourceId} id={sourceId} renders={overview?.renders.filter((r) => r.settings.curiosity?.sourceJobId === sourceId) ?? []} onRendered={refresh} />}
    </div>
  );
}

function Hero() {
  const [mouth, setMouth] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    // Boca "falando" sozinha no banner, só de enfeite
    const seq: (0 | 1 | 2)[] = [1, 2, 1, 0, 2, 1, 2, 0, 0, 1, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let i = 0;
    const t = setInterval(() => setMouth(seq[i++ % seq.length]), 110);
    return () => clearInterval(t);
  }, []);
  return (
    <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-[#2a1140] via-[#5b2a6e] to-[#e07a3a] p-6 sm:p-8">
      <div className="relative flex items-center gap-6">
        <div className="min-w-0 flex-1 space-y-3">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium">
            <Sparkles className="size-3.5 text-amber-300" /> Curiosidades · Filmes e séries
          </span>
          <h1 className="text-3xl font-semibold uppercase tracking-wide text-white sm:text-4xl">
            Um vídeo-fonte, <span className="text-amber-300">vários vídeos narrados</span>
          </h1>
          <p className="max-w-xl text-sm text-white/75">
            Mande um documentário, aula ou podcast. A IA lê tudo, sugere ideias nos formatos que viralizam (Top N, Você sabia, Mito vs verdade…) com gancho, roteiro e CTA. Você escolhe, ajusta os trechos à mão e gera os vídeos, com ou sem o apresentador narrando.
          </p>
        </div>
        <div className="-mb-8 hidden shrink-0 sm:block">
          <NarratorAvatar mouth={mouth} className="h-56 w-[188px] drop-shadow-[0_12px_30px_rgba(0,0,0,0.45)]" />
        </div>
      </div>
    </section>
  );
}

// ---------------- 1 e 2. Vídeo-fonte + formatos ----------------

function NewSource({ onCreated }: { onCreated: (jobId: string) => void }) {
  const [files, setFiles] = useState<InputFile[]>([]);
  const [selected, setSelected] = useState('');
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null);
  const [templates, setTemplates] = useState<Set<CuriosityTemplateKey>>(new Set(['top_n', 'voce_sabia', 'mito_verdade', 'e_se']));
  const [count, setCount] = useState(8);
  const [topic, setTopic] = useState('');
  const [target, setTarget] = useState<30 | 60>(60);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function loadFiles(select?: string) {
    const r = await api<{ files: InputFile[] }>('/api/inputs');
    setFiles(r.files);
    if (select) setSelected(select);
    else setSelected((cur) => cur || r.files[0]?.name || '');
  }
  useEffect(() => {
    loadFiles().catch(() => undefined);
  }, []);

  async function handleFiles(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    setUpload({ name: file.name, progress: 0 });
    try {
      const r = await uploadFile(file, (p) => setUpload({ name: file.name, progress: p }));
      await loadFiles(r.name);
    } catch (e) {
      setMessage({ type: 'error', text: (e as Error).message });
    } finally {
      setUpload(null);
    }
  }

  async function generate() {
    if (!selected) return setMessage({ type: 'error', text: 'Escolha ou envie o vídeo-fonte.' });
    if (!templates.size) return setMessage({ type: 'error', text: 'Escolha pelo menos um formato.' });
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ job: Job }>('/api/curiosities', {
        method: 'POST',
        body: JSON.stringify({ inputFile: selected, templates: [...templates], count, topic, targetSeconds: target, settings: DEFAULT_JOB_SETTINGS }),
      });
      setMessage({ type: 'ok', text: 'Gerando ideias… a galeria abre aqui embaixo quando terminar.' });
      onCreated(r.job.id);
    } catch (e) {
      setMessage({ type: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const toggle = (k: CuriosityTemplateKey) =>
    setTemplates((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <section className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-3 rounded-2xl border bg-card p-5">
        <StepTitle n={1} title="Vídeo-fonte" />
        <div
          onClick={() => !upload && fileInput.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            handleFiles(e.dataTransfer.files);
          }}
          className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-5 text-center transition-colors hover:border-primary/60 hover:bg-accent/40"
        >
          {upload ? (
            <div className="w-full space-y-2">
              <p className="truncate text-sm">Enviando {upload.name}…</p>
              <Progress value={upload.progress * 100} />
            </div>
          ) : (
            <>
              <UploadCloud className="size-7 text-primary" />
              <p className="text-sm font-medium">Arraste ou clique para enviar</p>
              <p className="text-xs text-muted-foreground">Documentários, aulas, podcasts…</p>
            </>
          )}
          <input ref={fileInput} type="file" accept="video/*,.mkv" className="hidden" onChange={(e) => handleFiles(e.target.files)} />
        </div>
        <div className="flex gap-2">
          <Select value={selected} onChange={(e) => setSelected(e.target.value)} className="min-w-0 flex-1">
            {!files.length && <option value="">Nenhum vídeo em data/input</option>}
            {files.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name} ({formatBytes(f.size)})
              </option>
            ))}
          </Select>
          <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => loadFiles()} title="Atualizar lista">
            <RefreshCw />
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Quantas ideias</Label>
            <Input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
          </div>
          <div className="space-y-1.5">
            <Label>Foco (opcional)</Label>
            <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="ex.: vulcões" maxLength={300} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Duração de cada vídeo</Label>
          <div className="grid grid-cols-2 overflow-hidden rounded-lg border text-sm">
            {([30, 60] as const).map((d) => (
              <button key={d} type="button" onClick={() => setTarget(d)} className={cn('py-2 font-semibold', target === d ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>
                {d}s
              </button>
            ))}
          </div>
        </div>
        {message && <p className={cn('rounded-md px-3 py-2 text-sm', message.type === 'ok' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')}>{message.text}</p>}
        <Button size="lg" className="w-full bg-gradient-to-r from-[#5b2a6e] to-[#e07a3a] text-white hover:opacity-90" onClick={generate} disabled={busy || !selected || !!upload}>
          {busy ? <Loader2 className="animate-spin" /> : <Wand2 />} Gerar ideias com IA
        </Button>
      </div>

      <div className="space-y-3 rounded-2xl border bg-card p-5 lg:col-span-2">
        <div className="flex items-center justify-between gap-3">
          <StepTitle n={2} title="Formatos do canal" />
          <span className="text-xs text-muted-foreground">{templates.size} de {CURIOSITY_TEMPLATES.length} escolhidos</span>
        </div>
        {(['curiosidade', 'filme'] as const).map((group) => (
        <div key={group} className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{group === 'curiosidade' ? 'Curiosidades' : 'Filmes e séries (narração por cima de trechos curtos)'}</h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {CURIOSITY_TEMPLATES.filter((t) => t.group === group).map((t) => {
            const on = templates.has(t.key);
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => toggle(t.key)}
                className={cn(
                  'group relative overflow-hidden rounded-xl border p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg',
                  on ? 'border-transparent ring-2 ring-white/70' : 'opacity-70 hover:opacity-100',
                )}
                style={{ background: on ? gradient(t.key) : undefined }}
              >
                {!on && <div className="absolute inset-x-0 top-0 h-1" style={{ background: gradient(t.key) }} />}
                <div className="flex items-start justify-between">
                  <span className="text-3xl drop-shadow transition-transform duration-200 group-hover:scale-110">{t.emoji}</span>
                  <span className={cn('grid size-5 place-items-center rounded-full border', on ? 'border-white bg-white text-black' : 'border-white/30')}>{on && <Check className="size-3.5" />}</span>
                </div>
                <div className={cn('mt-2 text-sm font-bold', on && 'text-white')}>{t.label}</div>
                <div className={cn('mt-0.5 line-clamp-2 text-[11px]', on ? 'text-white/85' : 'text-muted-foreground')}>{t.desc}</div>
                <div className={cn('mt-2 space-y-0.5 text-[10px] leading-snug', on ? 'text-white/90' : 'text-muted-foreground')}>
                  <p>
                    <b>Gancho</b> · {t.hook}
                  </p>
                  <p className="line-clamp-2">
                    <b>Roteiro</b> · {t.script}
                  </p>
                  <p className="line-clamp-1">
                    <b>CTA</b> · {t.cta}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
        </div>
        ))}
      </div>
    </section>
  );
}

function StepTitle({ n, title }: { n: number; title: string }) {
  return (
    <h2 className="flex items-center gap-2 text-base font-bold">
      <span className="grid size-6 place-items-center rounded-full bg-gradient-to-br from-[#5b2a6e] to-[#e07a3a] text-xs text-white">{n}</span>
      {title}
    </h2>
  );
}

function SourcesStrip({ overview, current }: { overview: Overview | null; current: string | null }) {
  if (!overview?.sources.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">Vídeos-fonte analisados</h2>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {overview.sources.map(({ job, ideas }) => (
          <Link
            key={job.id}
            href={`/curiosidades?fonte=${job.id}`}
            className={cn('flex min-w-56 max-w-72 shrink-0 flex-col gap-1 rounded-xl border p-3 transition-colors', current === job.id ? 'border-primary bg-primary/10' : 'bg-card hover:bg-accent/40')}
          >
            <span className="truncate text-sm font-medium">{job.videoName}</span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <JobStatusBadge status={job.status} />
              {job.status === 'completed' ? `${ideas} ideias` : job.status === 'processing' ? stepLabel(job.step) : ''}
            </span>
            {(job.status === 'processing' || job.status === 'pending') && <Progress value={job.progress * 100} className="h-1" />}
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---------------- 3. Galeria de ideias ----------------

function IdeaGallery({ id, renders, onRendered }: { id: string; renders: Job[]; onRendered: () => void }) {
  const [data, setData] = useState<{ job: Job; analysis: CuriosityAnalysis | null } | null>(null);
  const [ideas, setIdeas] = useState<CuriosityIdea[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState<CuriosityTemplateKey | 'all'>('all');
  const [narrator, setNarrator] = useState(true);
  const [format, setFormat] = useState<OutputFormat>('vertical_blur');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Enquanto a análise roda, consulta até as ideias chegarem
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const d = await api<{ job: Job; analysis: CuriosityAnalysis | null }>(`/api/curiosities/${id}`);
        if (!alive) return;
        setData(d);
        if (d.analysis) {
          setIdeas(d.analysis.ideas);
          setPicked(new Set(d.analysis.ideas.slice(0, 3).map((i) => i.id)));
          setEditing(d.analysis.ideas[0]?.id ?? null);
          const name = d.analysis.inputPath.split(/[\\/]/).pop()!;
          api<{ path: string }>(`/api/inputs/preview?name=${encodeURIComponent(name)}`)
            .then((r) => alive && setVideoSrc(fileUrl(r.path)))
            .catch(() => alive && setVideoSrc(fileUrl(d.analysis!.inputPath)));
          return;
        }
        if (d.job.status !== 'failed' && d.job.status !== 'cancelled') timer = setTimeout(load, 2000);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);

  function update(next: CuriosityIdea[]) {
    setIdeas(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => api(`/api/curiosities/${id}`, { method: 'PUT', body: JSON.stringify({ ideas: next }) }).catch((e) => setError((e as Error).message)), 600);
  }
  const patch = (ideaId: string, p: Partial<CuriosityIdea>) => update(ideas.map((i) => (i.id === ideaId ? { ...i, ...p } : i)));

  function addManual() {
    const start = 0;
    const idea: CuriosityIdea = {
      id: `m${Date.now().toString(36)}`,
      template: filter === 'all' ? 'voce_sabia' : filter,
      title: 'Nova ideia',
      hook: 'Você sabia que...',
      script: 'Você sabia que... Escreva aqui a narração. Segue para mais curiosidades!',
      cta: 'Segue para mais curiosidades!',
      segments: [{ start, end: start + 20, label: null }],
      score: 60,
      reason: 'Montada à mão',
      hashtags: ['#curiosidades'],
      manual: true,
    };
    update([idea, ...ideas]);
    setEditing(idea.id);
    setPicked((s) => new Set([...s, idea.id]));
  }

  async function render() {
    const chosen = ideas.filter((i) => picked.has(i.id));
    if (!chosen.length) return;
    setSending(true);
    setError(null);
    try {
      await api(`/api/curiosities/${id}/render`, {
        method: 'POST',
        body: JSON.stringify({ ideas: chosen, narrator, settings: { ...DEFAULT_JOB_SETTINGS, format, intensity: 'medium' } }),
      });
      onRendered();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  if (error && !data) return <p className="text-destructive">{error}</p>;
  if (!data) return <p className="text-muted-foreground">Carregando…</p>;
  if (!data.analysis) {
    const j = data.job;
    return (
      <section className="flex flex-col items-center gap-4 rounded-2xl border bg-card p-10 text-center">
        {j.status === 'failed' ? (
          <p className="text-destructive">A análise falhou: {j.error}</p>
        ) : (
          <>
            <NarratorAvatar mouth={1} className="h-24 w-auto animate-pulse" />
            <p className="font-semibold">Lendo o vídeo-fonte e montando as ideias…</p>
            <p className="text-sm text-muted-foreground">{stepLabel(j.step)}</p>
            <Progress value={j.progress * 100} className="w-72" />
            <Link href={`/jobs/${j.id}`} className="text-xs text-muted-foreground underline">
              ver logs do job
            </Link>
          </>
        )}
      </section>
    );
  }

  const a = data.analysis;
  const shown = ideas.filter((i) => filter === 'all' || i.template === filter);
  const current = ideas.find((i) => i.id === editing) ?? null;
  const usedTemplates = CURIOSITY_TEMPLATES.filter((t) => ideas.some((i) => i.template === t.key));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <StepTitle n={3} title={`Galeria de ideias · ${a.videoName}`} />
          {a.summary && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{a.summary}</p>}
          <p className="mt-1 text-xs text-muted-foreground">
            {ideas.length} ideias · fonte de {formatTimestamp(a.duration)} · {a.provider}
          </p>
        </div>
        <Button variant="outline" onClick={addManual}>
          <Scissors /> Ideia manual
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <FilterChip on={filter === 'all'} onClick={() => setFilter('all')} label={`Todas (${ideas.length})`} />
        {usedTemplates.map((t) => (
          <FilterChip key={t.key} on={filter === t.key} onClick={() => setFilter(t.key)} label={`${t.emoji} ${t.label} (${ideas.filter((i) => i.template === t.key).length})`} color={gradient(t.key)} />
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
        <div className="grid content-start gap-3 sm:grid-cols-2">
          {shown.map((idea) => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              active={editing === idea.id}
              picked={picked.has(idea.id)}
              onOpen={() => setEditing(idea.id)}
              onPick={() =>
                setPicked((s) => {
                  const n = new Set(s);
                  if (n.has(idea.id)) n.delete(idea.id);
                  else n.add(idea.id);
                  return n;
                })
              }
            />
          ))}
        </div>
        <div className="xl:sticky xl:top-20 xl:self-start">
          {current ? (
            <IdeaEditor
              key={current.id}
              idea={current}
              videoSrc={videoSrc}
              duration={a.duration}
              narrator={narrator}
              onChange={(p) => patch(current.id, p)}
              onDelete={() => {
                update(ideas.filter((i) => i.id !== current.id));
                setEditing(null);
              }}
            />
          ) : (
            <div className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">Clique numa ideia para ajustar os trechos e ver a prévia.</div>
          )}
        </div>
      </div>

      {renders.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">Vídeos gerados desta fonte</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {renders.map((r) => (
              <Link key={r.id} href={`/jobs/${r.id}`} className="flex items-center gap-3 rounded-xl border bg-card p-3 hover:bg-accent/40">
                <Film className="size-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">
                    {r.settings.curiosity?.ideas?.length} vídeo(s){r.settings.curiosity?.narrator ? ' · com narrador' : ''}
                  </div>
                  <div className="text-xs text-muted-foreground">{r.status === 'processing' ? stepLabel(r.step) : new Date(r.createdAt).toLocaleString('pt-BR')}</div>
                  {r.status === 'processing' && <Progress value={r.progress * 100} className="mt-1 h-1" />}
                </div>
                <JobStatusBadge status={r.status} />
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Barra de ação fixa */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <span className="text-sm">
            <b className="text-lg">{picked.size}</b> ideia(s) · {formatTimestamp(ideas.filter((i) => picked.has(i.id)).reduce((s, i) => s + ideaDuration(i), 0))} de vídeo
          </span>
          <label className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm">
            {narrator ? <Mic className="size-4 text-amber-300" /> : <MicOff className="size-4 text-muted-foreground" />}
            Narrador
            <Switch checked={narrator} onCheckedChange={setNarrator} />
          </label>
          <Select value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)} className="w-48">
            <option value="vertical_blur">Vertical 9:16 (fundo desfocado)</option>
            <option value="vertical_crop">Vertical 9:16 (recorte)</option>
            <option value="square">Quadrado 1:1</option>
          </Select>
          {error && <span className="text-sm text-destructive">{error}</span>}
          <Button size="lg" className="ml-auto bg-gradient-to-r from-[#5b2a6e] to-[#e07a3a] text-white hover:opacity-90" disabled={!picked.size || sending} onClick={render}>
            {sending ? <Loader2 className="animate-spin" /> : <Sparkles />} Gerar {picked.size} vídeo(s)
          </Button>
        </div>
      </div>
    </section>
  );
}

function FilterChip({ on, onClick, label, color }: { on: boolean; onClick: () => void; label: string; color?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', on ? 'border-transparent text-white' : 'hover:bg-accent/40')} style={on ? { background: color ?? 'var(--primary)' } : undefined}>
      {label}
    </button>
  );
}

function IdeaCard({ idea, active, picked, onOpen, onPick }: { idea: CuriosityIdea; active: boolean; picked: boolean; onOpen: () => void; onPick: () => void }) {
  const t = curiosityTemplate(idea.template);
  const dur = ideaDuration(idea);
  return (
    <div
      onClick={onOpen}
      className={cn(
        'group relative cursor-pointer overflow-hidden rounded-2xl border bg-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl',
        active && 'ring-2 ring-primary',
      )}
    >
      <div className="relative flex items-center gap-2 px-3 py-2.5 text-white" style={{ background: gradient(idea.template) }}>
        <span className="text-2xl transition-transform duration-200 group-hover:rotate-12 group-hover:scale-110">{t.emoji}</span>
        <span className="text-xs font-bold uppercase tracking-wide">{t.label}</span>
        {idea.manual && <span className="rounded bg-black/25 px-1.5 text-[10px]">manual</span>}
        <span className="ml-auto rounded-full bg-black/25 px-2 py-0.5 text-xs font-bold">{Math.round(idea.score)}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPick();
          }}
          title={picked ? 'Tirar da seleção' : 'Selecionar para gerar'}
          className={cn('grid size-6 place-items-center rounded-full border-2 border-white transition-colors', picked ? 'bg-white text-black' : 'bg-black/10')}
        >
          {picked && <Check className="size-4" />}
        </button>
      </div>
      <div className="space-y-2 p-3">
        <h3 className="line-clamp-2 font-bold leading-snug">{idea.title}</h3>
        <p className="line-clamp-2 border-l-2 pl-2 text-sm italic text-muted-foreground" style={{ borderColor: t.from }}>
          “{idea.hook}”
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
            <Clock className="size-3" /> {dur.toFixed(0)}s
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5">{idea.segments.length} trecho(s)</span>
          <span className="rounded-full bg-muted px-2 py-0.5">~{speechSeconds(idea.script).toFixed(0)}s de narração</span>
        </div>
        {idea.reason && <p className="line-clamp-2 text-xs text-muted-foreground">{idea.reason}</p>}
      </div>
    </div>
  );
}

// ---------------- Editor da ideia: trechos à mão + prévia vertical ----------------

function IdeaEditor({
  idea,
  videoSrc,
  duration,
  narrator,
  onChange,
  onDelete,
}: {
  idea: CuriosityIdea;
  videoSrc: string | null;
  duration: number;
  narrator: boolean;
  onChange: (p: Partial<CuriosityIdea>) => void;
  onDelete: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const bg = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  const [seg, setSeg] = useState(0);
  const [mouth, setMouth] = useState<0 | 1 | 2>(0);
  const [speaking, setSpeaking] = useState(false);
  const [showHook, setShowHook] = useState(true);
  const playSeq = useRef<{ i: number } | null>(null);
  const t = curiosityTemplate(idea.template);
  const total = ideaDuration(idea);
  const speech = speechSeconds(idea.script);

  // Tempo no corte (soma dos trechos anteriores + posição no atual)
  const clipTime = useMemo(() => {
    let off = 0;
    for (let i = 0; i < idea.segments.length; i++) {
      const s = idea.segments[i];
      if (now >= s.start && now <= s.end) return off + now - s.start;
      off += s.end - s.start;
    }
    return null;
  }, [now, idea.segments]);

  useEffect(() => {
    setShowHook(clipTime === null || clipTime < 3.4);
  }, [clipTime]);

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  function onTime() {
    const v = video.current!;
    setNow(v.currentTime);
    if (bg.current && Math.abs(bg.current.currentTime - v.currentTime) > 0.3) bg.current.currentTime = v.currentTime;
    // Tocando a sequência: ao fim de um trecho pula para o próximo
    const sq = playSeq.current;
    if (sq) {
      const s = idea.segments[sq.i];
      if (v.currentTime >= s.end) {
        if (sq.i + 1 < idea.segments.length) {
          sq.i++;
          setSeg(sq.i);
          v.currentTime = idea.segments[sq.i].start;
        } else {
          playSeq.current = null;
          v.pause();
        }
      }
    }
  }

  function playSequence() {
    const v = video.current;
    if (!v) return;
    if (playing) {
      v.pause();
      playSeq.current = null;
      window.speechSynthesis?.cancel();
      return;
    }
    playSeq.current = { i: 0 };
    setSeg(0);
    v.currentTime = idea.segments[0].start;
    v.play();
    if (narrator) speak();
  }

  /** Prévia da narração com a voz do navegador: a boca abre a cada palavra (no vídeo final, pela amplitude). */
  function speak() {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(idea.script);
    u.lang = 'pt-BR';
    u.rate = 1.1;
    const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith('pt'));
    if (voice) u.voice = voice;
    let timer: ReturnType<typeof setInterval> | null = null;
    u.onstart = () => {
      setSpeaking(true);
      timer = setInterval(() => setMouth((m) => (m === 0 ? (Math.random() > 0.5 ? 2 : 1) : Math.random() > 0.6 ? 0 : m === 1 ? 2 : 1)), 95);
    };
    u.onend = u.onerror = () => {
      if (timer) clearInterval(timer);
      setMouth(0);
      setSpeaking(false);
    };
    synth.speak(u);
  }

  const setSegment = (i: number, p: Partial<CuriosityIdea['segments'][number]>) =>
    onChange({ segments: idea.segments.map((s, k) => (k === i ? { ...s, ...p, start: Math.max(0, p.start ?? s.start), end: Math.min(duration, p.end ?? s.end) } : s)) });

  return (
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="h-1.5" style={{ background: gradient(idea.template) }} />
      <div className="grid gap-4 p-4 sm:grid-cols-[220px_minmax(0,1fr)]">
        {/* Prévia vertical 9:16 */}
        <div className="space-y-2">
          <div className="relative mx-auto aspect-[9/16] w-full max-w-[220px] overflow-hidden rounded-xl bg-black shadow-2xl">
            {videoSrc ? (
              <>
                <video ref={bg} src={videoSrc} muted className="absolute inset-0 size-full scale-125 object-cover opacity-60 blur-lg" />
                <video
                  ref={video}
                  src={videoSrc}
                  className="absolute inset-x-0 top-1/2 w-full -translate-y-1/2"
                  onTimeUpdate={onTime}
                  onPlay={() => (setPlaying(true), bg.current?.play())}
                  onPause={() => (setPlaying(false), bg.current?.pause())}
                  onLoadedMetadata={(e) => (e.currentTarget.currentTime = idea.segments[0]?.start ?? 0)}
                  playsInline
                />
              </>
            ) : (
              <div className="grid size-full place-items-center text-xs text-muted-foreground">Carregando vídeo…</div>
            )}
            <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[8px] font-black uppercase text-white">{idea.spoiler ? `Alerta de spoiler · ${t.label}` : t.label}</span>
            <div className={cn('absolute inset-x-3 top-[9%] text-center transition-all duration-300', showHook ? 'scale-100 opacity-100' : 'scale-90 opacity-0')}>
              <span className="box-decoration-clone rounded px-1.5 py-0.5 text-[13px] font-black leading-tight text-white" style={{ background: t.from, boxShadow: `0 0 0 3px ${t.to}` }}>
                {idea.hook}
              </span>
            </div>
            {narrator && (
              <div className="absolute bottom-[5%] left-[3%] w-[42%]">
                <NarratorAvatar mouth={mouth} className="w-full drop-shadow-lg" />
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" onClick={playSequence} disabled={!videoSrc}>
              {playing ? <Pause /> : <Play />} {playing ? 'Pausar' : 'Tocar corte'}
            </Button>
            <Button size="sm" variant="outline" onClick={speak} title="Ouvir só a narração (voz do navegador)">
              <Mic />
            </Button>
            <SpeedPicker />
          </div>
          <p className="text-center text-[11px] text-muted-foreground">
            {clipTime !== null ? `${clipTime.toFixed(1)}s de ${total.toFixed(1)}s` : `no vídeo: ${formatTimestamp(now)}`}
          </p>
        </div>

        {/* Campos */}
        <div className="min-w-0 space-y-3">
          <div className="flex gap-2">
            <Select value={idea.template} onChange={(e) => onChange({ template: e.target.value as CuriosityTemplateKey })} className="flex-1">
              {CURIOSITY_TEMPLATES.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.emoji} {x.label}
                </option>
              ))}
            </Select>
            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={onDelete} title="Excluir ideia">
              <Trash2 />
            </Button>
          </div>
          <Field label="Título do post">
            <Input value={idea.title} onChange={(e) => onChange({ title: e.target.value })} maxLength={140} />
          </Field>
          <Field label="Gancho (primeiros 3s)">
            <Input value={idea.hook} onChange={(e) => onChange({ hook: e.target.value })} maxLength={200} />
          </Field>
          <Field label={`Roteiro da narração · ~${speech.toFixed(0)}s`} hint={narrator && speech > total + 8 ? 'Mais longo que os trechos: o último quadro fica parado até a fala acabar' : undefined}>
            <textarea
              value={idea.script}
              onChange={(e) => onChange({ script: e.target.value })}
              maxLength={2000}
              rows={5}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </Field>
          <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
            Alerta de spoiler
            <Switch checked={!!idea.spoiler} onCheckedChange={(v) => onChange({ spoiler: v })} />
          </label>
          <Field label="CTA (final)">
            <Input value={idea.cta} onChange={(e) => onChange({ cta: e.target.value })} maxLength={200} />
          </Field>
        </div>
      </div>

      {/* Trechos: corte manual */}
      <div className="space-y-2 border-t p-4">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5">
            <Scissors className="size-4" /> Trechos do vídeo-fonte · {total.toFixed(1)}s
          </Label>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const at = Math.min(duration - 2, video.current?.currentTime ?? 0);
              onChange({ segments: [...idea.segments, { start: at, end: Math.min(duration, at + 8), label: null }] });
            }}
          >
            <Plus /> Trecho no tempo atual
          </Button>
        </div>
        <Timeline duration={duration} segments={idea.segments} now={now} color={t.from} onSeek={(x) => video.current && (video.current.currentTime = x)} />
        {idea.segments.map((s, i) => (
          <div key={i} className={cn('flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm', seg === i && playing && 'border-primary')}>
            <span className="grid size-6 place-items-center rounded-full text-xs font-bold text-white" style={{ background: gradient(idea.template) }}>
              {i + 1}
            </span>
            <TimeInput value={s.start} onChange={(v) => setSegment(i, { start: v })} />
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => video.current && setSegment(i, { start: video.current.currentTime })} title="Início = tempo atual do player">
              ⇤ agora
            </Button>
            <span className="text-muted-foreground">→</span>
            <TimeInput value={s.end} onChange={(v) => setSegment(i, { end: v })} />
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => video.current && setSegment(i, { end: video.current.currentTime })} title="Fim = tempo atual do player">
              agora ⇥
            </Button>
            <span className="text-xs text-muted-foreground">{(s.end - s.start).toFixed(1)}s</span>
            {idea.template === 'top_n' && <Input value={s.label ?? ''} onChange={(e) => setSegment(i, { label: e.target.value || null })} placeholder="nome do item" className="h-7 w-32 text-xs" maxLength={60} />}
            <div className="ml-auto flex gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                title="Tocar este trecho"
                onClick={() => {
                  const v = video.current;
                  if (!v) return;
                  playSeq.current = null;
                  v.currentTime = s.start;
                  v.play();
                  const stop = () => {
                    if (v.currentTime >= s.end) {
                      v.pause();
                      v.removeEventListener('timeupdate', stop);
                    }
                  };
                  v.addEventListener('timeupdate', stop);
                }}
              >
                <Play />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" disabled={idea.segments.length < 2} onClick={() => onChange({ segments: idea.segments.filter((_, k) => k !== i) })} title="Remover trecho">
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Tudo é salvo automaticamente. Depois de gerado, cada vídeo também pode ser refinado no editor manual (botão Editar no job).</p>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-warning">{hint}</p>}
    </div>
  );
}

function TimeInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(value.toFixed(1));
  useEffect(() => setText(value.toFixed(1)), [value]);
  return (
    <Input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = Number(text.replace(',', '.'));
        if (Number.isFinite(v)) onChange(v);
        else setText(value.toFixed(1));
      }}
      className="h-7 w-20 text-xs tabular-nums"
      title="segundos no vídeo-fonte"
    />
  );
}

/** Linha do tempo do vídeo-fonte inteiro com os trechos da ideia marcados; clique para pular. */
function Timeline({ duration, segments, now, color, onSeek }: { duration: number; segments: CuriosityIdea['segments']; now: number; color: string; onSeek: (t: number) => void }) {
  const pct = (t: number) => `${(Math.max(0, Math.min(duration, t)) / duration) * 100}%`;
  return (
    <div
      className="relative h-8 cursor-pointer overflow-hidden rounded-md bg-muted"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - r.left) / r.width) * duration);
      }}
    >
      {segments.map((s, i) => (
        <div key={i} className="absolute inset-y-1 grid place-items-center rounded-sm text-[10px] font-bold text-white" style={{ left: pct(s.start), width: `max(3px, calc(${pct(s.end)} - ${pct(s.start)}))`, background: color }}>
          {i + 1}
        </div>
      ))}
      <div className="absolute inset-y-0 w-0.5 bg-white" style={{ left: pct(now) }} />
      <span className="absolute bottom-0.5 right-1 text-[10px] text-muted-foreground">{formatTimestamp(duration)}</span>
    </div>
  );
}
