'use client';
// Limpar vídeo: o usuário baixa um vídeo da internet, marca o que tirar (trechos, logo, legenda) e liga as
// ferramentas (música, pausas, ruído, volume, bordas). O worker gera o vídeo limpo e o botão "Levar para o editor"
// copia o resultado para data/input e abre o Painel com ele selecionado.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, AudioLines, Sparkles, Star, Download, Eraser, Film, Music, VideoOff, Loader2, Pause, Play, Plus, RefreshCw, Scissors, Square, Subtitles, Trash2, UploadCloud, X } from 'lucide-react';
import { DEFAULT_CLEAN_SPEC, formatBytes, formatTimestamp, keptSegments, UPSCALE_MODELS, type CleanBox, type CleanSpec, type Job } from '@clipper/shared';
import { EnhanceCompare, type EnhanceShot } from '@/components/enhance-compare';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select } from '@/components/ui/select';
import { Skeleton, SkeletonVideo } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { JobStatusBadge } from '@/components/job-status';
import { api, fileUrl, uploadFile, usePolling } from '@/lib/client';
import { cn } from '@/lib/utils';
import { SpeedPicker } from '@/components/speed-picker';

interface InputFile {
  name: string;
  size: number;
}
type Options = Omit<CleanSpec, 'file'>;
type Draw = 'logo' | 'band' | null;

const STEP_LABEL: Record<string, string> = {
  silences: 'Procurando pausas',
  cut: 'Cortando trechos',
  subtitles: 'Apagando a legenda',
  music: 'Separando a voz da música',
  final: 'Finalizando (logo, bordas e áudio)',
  stems: 'Separando as faixas para baixar',
  upscale_extract: 'Melhorar qualidade: extraindo os quadros',
  upscale_encode: 'Melhorar qualidade: remontando o vídeo com o áudio',
};
/** "upscale 120/900" → "Melhorando a qualidade (quadro 120 de 900)". */
function stepLabel(step: string): string {
  const m = /^upscale (\d+)\/(\d+)$/.exec(step);
  if (m) return `Melhorando a qualidade na GPU (quadro ${m[1]} de ${m[2]})`;
  return STEP_LABEL[step] ?? step;
}
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function CleanStudio() {
  const router = useRouter();
  const [files, setFiles] = useState<InputFile[] | null>(null);
  const [file, setFile] = useState('');
  const [opts, setOpts] = useState<Options>(DEFAULT_CLEAN_SPEC);
  // Momento da prévia (para comparar as versões do "Melhorar qualidade" nesse quadro)
  const previewTime = useRef(0);
  const [shot, setShot] = useState<EnhanceShot | null>(null);
  // Vídeo e resolução da comparação mostrada: mudou a resolução, gera de novo no mesmo quadro
  const [shotFor, setShotFor] = useState('');
  const compareKey = `${file}|${opts.upscaleTo}`;
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  async function compare() {
    if (!file || !opts.upscaleTo) return;
    setComparing(true);
    setCompareError(null);
    try {
      setShotFor(compareKey);
      setShot(await api<EnhanceShot>('/api/clean/enhance-preview', { method: 'POST', body: JSON.stringify({ file, at: previewTime.current, target: opts.upscaleTo }) }));
    } catch (e) {
      setShot(null);
      setCompareError((e as Error).message);
    } finally {
      setComparing(false);
    }
  }
  useEffect(() => {
    if (!shot || comparing || shotFor === compareKey) return;
    if (file && opts.upscaleTo && shotFor.startsWith(`${file}|`)) void compare();
    else setShot(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareKey]);
  const [upload, setUpload] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Esconde o card de resultado depois de "Nova limpeza" (até escolher uma do histórico ou limpar de novo)
  const [hidden, setHidden] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { data, refresh } = usePolling(() => api<{ jobs: Job[]; inputDir: string }>('/api/clean'), 1500);

  const set = <K extends keyof Options>(k: K, v: Options[K]) => setOpts((o) => ({ ...o, [k]: v }));

  async function loadFiles(select?: string) {
    const r = await api<{ files: InputFile[] }>('/api/inputs');
    setFiles(r.files);
    if (select) setFile(select);
    else setFile((f) => f || r.files[0]?.name || '');
  }
  useEffect(() => {
    loadFiles().catch(() => undefined);
  }, []);

  async function handleUpload(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    setError(null);
    setUpload(0);
    try {
      const r = await uploadFile(f, setUpload);
      await loadFiles(r.name);
      pickFile(r.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUpload(null);
    }
  }
  function pickFile(name: string) {
    setFile(name);
    // Cortes, logos e faixa valem para um vídeo específico
    setOpts((o) => ({ ...o, cuts: [], logos: [], subtitleBand: null }));
    setJobId(null);
  }

  async function start() {
    setError(null);
    try {
      const r = await api<{ job: Job }>('/api/clean', { method: 'POST', body: JSON.stringify({ file, ...opts }) });
      setJobId(r.job.id);
      setHidden(false);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function sendToEditor(id: string) {
    setSending(true);
    try {
      const r = await api<{ name: string }>('/api/clean/send', { method: 'POST', body: JSON.stringify({ jobId: id }) });
      router.push(`/?file=${encodeURIComponent(r.name)}`);
    } catch (e) {
      setError((e as Error).message);
      setSending(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Apagar esta limpeza e o vídeo limpo gerado?')) return;
    try {
      await api(`/api/clean?id=${id}`, { method: 'DELETE' });
      if (jobId === id) setJobId(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  /** Começa outra limpeza do zero: limpa as marcações e esconde o resultado. */
  function startOver() {
    setOpts(DEFAULT_CLEAN_SPEC);
    setJobId(null);
    setHidden(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const jobs = data?.jobs ?? [];
  const current = jobs.find((j) => j.id === jobId) ?? null;
  const running = jobs.find((j) => j.status === 'pending' || j.status === 'processing');
  const nothingOn = !opts.cuts.length && !opts.logos.length && !opts.trimSilence && !opts.removeMusic && !opts.removeSubtitles && !opts.cropBlackBars && !opts.denoise && !opts.normalizeAudio && !opts.exportStems && !opts.upscaleTo;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4 rounded-xl bg-gradient-to-r from-[#1f3b57] to-[#2f8f83] p-5 text-white">
        <span className="grid size-12 place-items-center rounded-xl bg-white/10">
          <Eraser className="size-6" />
        </span>
        <div className="flex-1">
          <h1 className="text-xl font-semibold">Limpar vídeo</h1>
          <p className="text-sm text-white/80">Tire o que não é seu de um vídeo baixado (trechos, música, legenda, logo) e mande o vídeo limpo para o editor.</p>
        </div>
        <ol className="flex gap-2 text-xs">
          {['1. Escolha o vídeo', '2. Marque o que tirar', '3. Limpe e confira', '4. Leve para o editor'].map((s) => (
            <li key={s} className="rounded-full bg-white/15 px-3 py-1">
              {s}
            </li>
          ))}
        </ol>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Card>
            <CardHeader>
              <CardTitle>1. Vídeo baixado</CardTitle>
              <CardDescription>Envie o arquivo ou escolha um que já está em data/input.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1.5">
                  {!files ? (
                    <Skeleton className="h-9 w-full" />
                  ) : (
                  <Select value={file} onChange={(e) => pickFile(e.target.value)}>
                    {!files.length && <option value="">Nenhum vídeo em data/input</option>}
                    {files.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.name} ({formatBytes(f.size)})
                      </option>
                    ))}
                  </Select>
                  )}
                </div>
                <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => loadFiles()} title="Atualizar lista">
                  <RefreshCw />
                </Button>
                <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={upload !== null}>
                  {upload !== null ? <Loader2 className="animate-spin" /> : <UploadCloud />}
                  {upload !== null ? `${Math.round(upload * 100)}%` : 'Enviar vídeo'}
                </Button>
                <input ref={fileInput} type="file" accept="video/*,.mkv" className="hidden" onChange={(e) => handleUpload(e.target.files)} />
              </div>
              {!files && <Skeleton className="aspect-video w-full" />}
              {file && <Marker key={file} videoName={file} opts={opts} set={set} onTime={(t) => (previewTime.current = t)} />}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>2. Ferramentas</CardTitle>
              <CardDescription>Ligue o que precisar. Tudo roda no seu PC.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              <Tool title="Cortar trechos" desc={opts.cuts.length ? `${opts.cuts.length} trecho(s) marcado(s) no vídeo` : 'Marque no vídeo as partes de outras pessoas, memes inseridos…'} checked={opts.cuts.length > 0} readOnly />
              <Tool title="Tirar a música (manter a voz)" desc="IA Demucs separa a voz do fundo musical. Mais demorado." checked={opts.removeMusic} onChange={(v) => set('removeMusic', v)} />
              <Tool title="Apagar legenda embutida" desc={opts.subtitleBand ? `Faixa marcada: ${Math.round(opts.subtitleBand.y * 100)}%–${Math.round((opts.subtitleBand.y + opts.subtitleBand.h) * 100)}% da altura` : 'Detecta a faixa da legenda sozinho (ou marque no vídeo)'} checked={opts.removeSubtitles} onChange={(v) => set('removeSubtitles', v)} />
              <Tool title="Remover marca d'água / logo" desc={opts.logos.length ? `${opts.logos.length} área(s) marcada(s)` : 'Desenhe um retângulo sobre a logo no vídeo'} checked={opts.logos.length > 0} readOnly />
              <Tool title="Tirar pausas sem fala" desc="Corta silêncios longos (deixa o vídeo mais dinâmico)" checked={opts.trimSilence} onChange={(v) => set('trimSilence', v)}>
                {opts.trimSilence && (
                  <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
                    Pausas maiores que
                    <Input type="number" min={0.3} max={10} step={0.1} value={opts.minSilence} onChange={(e) => set('minSilence', Number(e.target.value) || 0.8)} className="h-7 w-20" />s
                  </div>
                )}
              </Tool>
              <Tool title="Reduzir ruído" desc="Tira chiado e barulho de fundo constante" checked={opts.denoise} onChange={(v) => set('denoise', v)} />
              <Tool title="Normalizar volume" desc="Volume padrão de redes sociais (-14 LUFS)" checked={opts.normalizeAudio} onChange={(v) => set('normalizeAudio', v)} />
              <Tool title="Separar em faixas para baixar" desc="Gera também só a voz, só a música, o vídeo sem som e os trechos cortados (usa a IA Demucs)" checked={opts.exportStems} onChange={(v) => set('exportStems', v)} />
              <Tool title="Recortar bordas pretas" desc="Tira faixas pretas em volta da imagem" checked={opts.cropBlackBars} onChange={(v) => set('cropBlackBars', v)} />
              <Tool title="Melhorar qualidade (aumentar resolução)" desc="IA Real-ESRGAN na sua placa de vídeo: deixa vídeos borrados (ex.: 144p) mais nítidos" checked={!!opts.upscaleTo} onChange={(v) => set('upscaleTo', v ? 480 : 0)}>
                {!!opts.upscaleTo && (
                  <div className="space-y-2 pt-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Resolução</Label>
                        <Select value={String(opts.upscaleTo)} onChange={(e) => set('upscaleTo', Number(e.target.value) as Options['upscaleTo'])} className="h-8 text-xs">
                          <option value="480">Até 480p</option>
                          <option value="720">Até 720p</option>
                          <option value="1080">Até 1080p</option>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Modelo</Label>
                        <Select value={opts.upscaleModel ?? 'realistic'} onChange={(e) => set('upscaleModel', e.target.value as Options['upscaleModel'])} className="h-8 text-xs">
                          {UPSCALE_MODELS.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                    </div>
                    {/* Comparar antes de iniciar: o quadro atual da prévia na resolução escolhida, em cada versão */}
                    <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="outline" className="h-7" disabled={!file || comparing} onClick={compare}>
                          {comparing ? <Loader2 className="animate-spin" /> : <Sparkles />} {comparing ? 'Gerando as 4 versões… (até 1 min)' : 'Comparar versões neste momento'}
                        </Button>
                        <span className="text-muted-foreground">Pause a prévia no quadro que quer ver (de preferência com um rosto).</span>
                      </div>
                      {compareError && <p className="text-destructive">{compareError}</p>}
                      {shot && !comparing && (
                        <EnhanceCompare
                          shot={shot}
                          value={opts.upscaleModel ?? 'realistic'}
                          onPick={(m) => (m ? set('upscaleModel', m) : set('upscaleTo', 0))}
                        />
                      )}
                    </div>
                    <p className="flex gap-1.5 rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                      <Sparkles className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        Roda 100% no seu PC e não gasta tokens de IA. Leva alguns minutos (cada quadro passa pela IA). A IA pode &ldquo;inventar&rdquo; detalhes em rostos ou textos muito pequenos — confira o resultado.
                      </span>
                    </p>
                  </div>
                )}
              </Tool>
              <div className="pt-3">
                <Button className="w-full" size="lg" disabled={!file || nothingOn || !!running} onClick={start}>
                  {running ? <Loader2 className="animate-spin" /> : <Eraser />}
                  {running ? 'Limpando…' : 'Limpar vídeo'}
                </Button>
                {error && <p className="pt-2 text-sm text-destructive">{error}</p>}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {!hidden && (current ?? jobs[0]) && <ResultCard job={(current ?? jobs[0])!} sending={sending} onSend={sendToEditor} onDelete={remove} onNew={startOver} inputDir={data?.inputDir ?? ''} />}

      {!data && (
        <Card>
          <CardContent className="space-y-2 p-5">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      )}
      {jobs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Limpezas recentes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {jobs.map((j) => (
              <div key={j.id} className={cn('flex items-center gap-1 rounded-md border pr-1', !hidden && (current ?? jobs[0])?.id === j.id && 'border-primary')}>
                <button
                  onClick={() => {
                    setJobId(j.id);
                    setHidden(false);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <span className="flex-1 truncate">{j.settings.clean?.file}</span>
                  <span className="text-xs text-muted-foreground">{new Date(j.createdAt).toLocaleString('pt-BR')}</span>
                  <JobStatusBadge status={j.status} />
                </button>
                <Button size="icon" variant="ghost" onClick={() => remove(j.id)} disabled={j.status === 'processing'} title="Apagar do histórico (e o vídeo limpo)">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Tool({ title, desc, checked, onChange, readOnly, children }: { title: string; desc: string; checked: boolean; onChange?: (v: boolean) => void; readOnly?: boolean; children?: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg px-3 py-2', checked && 'bg-primary/5')}>
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{desc}</p>
        </div>
        {readOnly ? <span className={cn('size-2.5 rounded-full', checked ? 'bg-primary' : 'bg-input')} title={checked ? 'Ativo' : 'Marque no vídeo'} /> : <Switch checked={checked} onCheckedChange={(v) => onChange?.(v)} />}
      </div>
      {children}
    </div>
  );
}

/** Player do original: marca cortes na linha do tempo e desenha logo/faixa da legenda sobre o vídeo. */
function Marker({ videoName, opts, set, onTime }: { videoName: string; opts: Options; set: <K extends keyof Options>(k: K, v: Options[K]) => void; onTime?: (t: number) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<{ path?: string; error?: string } | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const [duration, setDuration] = useState(0);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [draw, setDraw] = useState<Draw>(null);
  const [draft, setDraft] = useState<CleanBox | null>(null);
  const [skipCuts, setSkipCuts] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const origin = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/inputs/preview?name=${encodeURIComponent(videoName)}`)
      .then((r) => r.json())
      .then((d) => alive && setSrc(d.path ? { path: d.path } : { error: d.error ?? 'erro ao abrir o vídeo' }))
      .catch((e) => alive && setSrc({ error: String(e) }));
    return () => {
      alive = false;
    };
  }, [videoName]);

  // Prévia "depois": pula os cortes durante a reprodução
  useEffect(() => {
    const v = video.current;
    if (!v || !playing || !skipCuts) return;
    const c = opts.cuts.find((c) => now >= c.start && now < c.end - 0.05);
    if (c) v.currentTime = c.end;
  }, [now, playing, skipCuts, opts.cuts]);

  const kept = useMemo(() => (duration ? keptSegments(duration, opts.cuts).reduce((a, s) => a + s.end - s.start, 0) : 0), [duration, opts.cuts]);

  function seek(t: number) {
    if (video.current) video.current.currentTime = Math.max(0, Math.min(duration, t));
  }
  function mark() {
    if (pending === null) return setPending(now);
    const c = { start: Math.min(pending, now), end: Math.max(pending, now) };
    if (c.end - c.start > 0.1) set('cuts', [...opts.cuts, c].sort((a, b) => a.start - b.start));
    setPending(null);
  }
  const point = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };
  function onDown(e: React.PointerEvent) {
    if (!draw) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    origin.current = point(e);
    setDraft({ ...origin.current, w: 0, h: 0 });
  }
  function onMove(e: React.PointerEvent) {
    if (!origin.current) return;
    const p = point(e);
    const o = origin.current;
    setDraft({ x: Math.min(o.x, p.x), y: Math.min(o.y, p.y), w: Math.abs(p.x - o.x), h: Math.abs(p.y - o.y) });
  }
  function onUp() {
    const d = draft;
    origin.current = null;
    setDraft(null);
    if (!d || d.w < 0.01 || d.h < 0.01) return;
    if (draw === 'logo') set('logos', [...opts.logos, d]);
    else if (draw === 'band') {
      set('subtitleBand', { y: d.y, h: Math.max(0.02, d.h) });
      set('removeSubtitles', true);
    }
    setDraw(null);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'i' || e.key === 'I' || e.key === 'o' || e.key === 'O') mark();
      if (e.key === ' ') {
        e.preventDefault();
        video.current?.paused ? video.current?.play() : video.current?.pause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (src?.error) return <p className="text-sm text-destructive">{src.error}</p>;
  const band = opts.subtitleBand;
  return (
    <div className="space-y-3">
      <div className="flex justify-center rounded-lg bg-black">
        <div ref={stage} className="relative max-h-[60vh] w-full" style={{ aspectRatio: aspect, maxWidth: `calc(60vh * ${aspect})` }}>
          <video
            ref={video}
            src={src?.path ? fileUrl(src.path) : undefined}
            className={cn('absolute inset-0 size-full transition-opacity duration-500', loaded ? 'opacity-100' : 'opacity-0')}
            onLoadedData={() => setLoaded(true)}
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration);
              if (e.currentTarget.videoWidth) setAspect(e.currentTarget.videoWidth / e.currentTarget.videoHeight);
            }}
            onTimeUpdate={(e) => {
              setNow(e.currentTarget.currentTime);
              onTime?.(e.currentTarget.currentTime);
            }}
            onSeeked={(e) => onTime?.(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onClick={() => !draw && (video.current?.paused ? video.current.play() : video.current?.pause())}
          />
          {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
          {opts.logos.map((b, i) => (
            <div key={i} className="group absolute border-2 border-amber-400 bg-amber-400/25" style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}>
              <span className="absolute -top-5 left-0 rounded bg-amber-400 px-1 text-[10px] font-medium text-black">logo</span>
              <button className="absolute -right-2 -top-2 grid size-4 place-items-center rounded-full bg-black text-white" onClick={() => set('logos', opts.logos.filter((_, k) => k !== i))} title="Tirar">
                <X className="size-3" />
              </button>
            </div>
          ))}
          {opts.removeSubtitles && band && (
            <div className="pointer-events-none absolute inset-x-0 border-y-2 border-dashed border-sky-400 bg-sky-400/20" style={{ top: `${band.y * 100}%`, height: `${band.h * 100}%` }}>
              <span className="absolute -top-5 left-1 rounded bg-sky-400 px-1 text-[10px] font-medium text-black">legenda</span>
            </div>
          )}
          {draw && <div className="absolute inset-0 cursor-crosshair bg-black/20" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />}
          {draw && <p className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-xs text-white">{draw === 'logo' ? 'Arraste sobre a logo / marca d’água' : 'Arraste sobre a legenda (só a altura conta)'}</p>}
          {draft && <div className="pointer-events-none absolute border-2 border-white bg-white/20" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }} />}
        </div>
      </div>

      {/* Linha do tempo: vermelho = vai ser cortado */}
      <div
        className="relative h-9 cursor-pointer overflow-hidden rounded-md bg-muted"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          seek(((e.clientX - r.left) / r.width) * duration);
        }}
      >
        {duration > 0 &&
          opts.cuts.map((c, i) => <div key={i} className="absolute inset-y-0 bg-red-500/60" style={{ left: `${(c.start / duration) * 100}%`, width: `${((c.end - c.start) / duration) * 100}%` }} />)}
        {duration > 0 && pending !== null && <div className="absolute inset-y-0 bg-red-500/30" style={{ left: `${(Math.min(pending, now) / duration) * 100}%`, width: `${(Math.abs(now - pending) / duration) * 100}%` }} />}
        {duration > 0 && <div className="absolute inset-y-0 w-0.5 bg-primary" style={{ left: `${(now / duration) * 100}%` }} />}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => (video.current?.paused ? video.current.play() : video.current?.pause())}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {formatTimestamp(now, true)} / {formatTimestamp(duration)}
        </span>
        <SpeedPicker />
        <Button size="sm" variant={pending === null ? 'outline' : 'destructive'} onClick={mark} title="Atalho: tecla I">
          <Scissors />
          {pending === null ? 'Início do corte' : `Fim do corte (desde ${formatTimestamp(pending, true)})`}
        </Button>
        {pending !== null && (
          <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
            Cancelar
          </Button>
        )}
        <Button size="sm" variant={draw === 'logo' ? 'default' : 'outline'} onClick={() => setDraw(draw === 'logo' ? null : 'logo')}>
          <Square /> Marcar logo
        </Button>
        <Button size="sm" variant={draw === 'band' ? 'default' : 'outline'} onClick={() => setDraw(draw === 'band' ? null : 'band')}>
          <Subtitles /> Marcar legenda
        </Button>
        {band && (
          <Button size="sm" variant="ghost" onClick={() => set('subtitleBand', null)} title="Volta a detectar a faixa sozinho">
            Faixa automática
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch checked={skipCuts} onCheckedChange={setSkipCuts} />
        Prévia: pular os trechos cortados ao tocar
        {duration > 0 && <span className="ml-auto">Fica com {formatTimestamp(kept)} de {formatTimestamp(duration)}</span>}
      </div>

      {opts.cuts.length > 0 && (
        <div className="space-y-1">
          <Label>Trechos que serão cortados</Label>
          {opts.cuts.map((c, i) => (
            <div key={i} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
              <button className="font-mono text-xs tabular-nums hover:underline" onClick={() => seek(c.start)}>
                {formatTimestamp(c.start, true)} → {formatTimestamp(c.end, true)}
              </button>
              <span className="text-xs text-muted-foreground">({(c.end - c.start).toFixed(1)}s)</span>
              <Button size="icon" variant="ghost" className="ml-auto h-6 w-6" onClick={() => set('cuts', opts.cuts.filter((_, k) => k !== i))} title="Tirar este corte">
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Andamento e, quando pronto, antes/depois lado a lado com "Levar para o editor". */
function ResultCard({ job, sending, onSend, onDelete, onNew, inputDir }: { job: Job; sending: boolean; onSend: (id: string) => void; onDelete: (id: string) => void; onNew: () => void; inputDir: string }) {
  const out = job.result?.cleanOutput;
  const before = useRef<HTMLVideoElement>(null);
  const after = useRef<HTMLVideoElement>(null);
  const [both, setBoth] = useState(false);
  const [fav, setFav] = useState<'idle' | 'busy' | 'done'>('idle');
  async function favorite() {
    setFav('busy');
    try {
      await api('/api/favorites/edited', { method: 'POST', body: JSON.stringify({ kind: 'clean', jobId: job.id }) });
      setFav('done');
    } catch (e) {
      alert((e as Error).message);
      setFav('idle');
    }
  }
  const original = inputDir && job.settings.clean ? `${inputDir.replace(/[\\/]+$/, '')}\\${job.settings.clean.file}` : '';
  const active = job.status === 'pending' || job.status === 'processing';
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <CardTitle className="flex-1">3. Antes e depois</CardTitle>
          <JobStatusBadge status={job.status} />
        </div>
        <CardDescription className="truncate">{job.settings.clean?.file}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {active && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <span>{job.status === 'pending' ? 'Na fila…' : stepLabel(job.step)}</span>
              <span className="tabular-nums text-muted-foreground">{Math.round(job.progress * 100)}%</span>
            </div>
            <Progress value={job.progress * 100} />
          </div>
        )}
        {job.status === 'failed' && (
          <div className="space-y-2">
            <p className="whitespace-pre-wrap text-sm text-destructive">{job.error}</p>
            <div className="flex gap-2">
              <Button variant="ghost" className="text-destructive" onClick={() => onDelete(job.id)}>
                <Trash2 /> Apagar
              </Button>
              <Button variant="outline" onClick={onNew}>
                <Plus /> Nova limpeza
              </Button>
            </div>
          </div>
        )}
        {job.status === 'completed' && out && (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Antes</Label>
                {original && <SkeletonVideo ref={before} src={fileUrl(original)} controls wrapperClassName="rounded-lg bg-black" className="aspect-video w-full" />}
              </div>
              <div className="space-y-1.5">
                <Label>Depois (limpo)</Label>
                <SkeletonVideo ref={after} src={fileUrl(out)} onEnded={() => setBoth(false)} controls wrapperClassName="rounded-lg bg-black" className="aspect-video w-full" />
              </div>
            </div>
            {job.result?.cleanStems && Object.keys(job.result.cleanStems).length > 0 && (
              <div className="space-y-1.5">
                <Label>Faixas separadas</Label>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {(
                    [
                      ['voice', 'Só a voz', 'áudio .m4a', <AudioLines key="i" />],
                      ['music', 'Só a música', 'áudio .m4a', <Music key="i" />],
                      ['silentVideo', 'Vídeo sem som', 'vídeo .mp4', <VideoOff key="i" />],
                      ['cutouts', 'Trechos cortados', 'vídeo .mp4', <Film key="i" />],
                    ] as const
                  ).map(([k, label, kind, icon]) => {
                    const f = job.result!.cleanStems![k];
                    if (!f) return null;
                    return (
                      <a key={k} href={fileUrl(f, true)} className="group flex items-center gap-3 rounded-lg border p-3 transition-all hover:-translate-y-0.5 hover:border-primary hover:bg-primary/5">
                        <span className="grid size-9 place-items-center rounded-md bg-primary/10 text-primary [&_svg]:size-4">{icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{label}</span>
                          <span className="block text-xs text-muted-foreground">{kind}</span>
                        </span>
                        <Download className="size-4 text-muted-foreground transition-colors group-hover:text-primary" />
                      </a>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  const vids = [before.current, after.current].filter((v): v is HTMLVideoElement => !!v);
                  // Toca os dois juntos do começo, para comparar o áudio/imagem; clicar de novo para os dois
                  if (both) vids.forEach((v) => v.pause());
                  else vids.forEach((v) => ((v.currentTime = 0), v.play()));
                  setBoth(!both);
                }}
              >
                {both ? <Pause /> : <Play />} {both ? 'Parar os dois' : 'Tocar os dois'}
              </Button>
              <SpeedPicker />
              <a href={fileUrl(out, true)}>
                <Button variant="outline">
                  <Download /> Baixar
                </Button>
              </a>
              <Button variant="outline" onClick={favorite} disabled={fav !== 'idle'}>
                {fav === 'busy' ? <Loader2 className="animate-spin" /> : <Star className={cn(fav === 'done' && 'fill-yellow-400 text-yellow-400')} />}
                {fav === 'done' ? 'Nos favoritos' : 'Favoritar'}
              </Button>
              <Button variant="ghost" className="text-destructive" onClick={() => onDelete(job.id)}>
                <Trash2 /> Apagar
              </Button>
              <Button variant="outline" onClick={onNew}>
                <Plus /> Nova limpeza
              </Button>
              <Button className="ml-auto" size="lg" onClick={() => onSend(job.id)} disabled={sending}>
                {sending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
                Levar para o editor
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
