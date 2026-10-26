'use client';
// Canal de memes: compilado de vídeos curtos editado à mão. Prévia grande no molde do canal (logo, título, vídeo
// na moldura arredondada) desenhada em 1080x1920 e escalada, com as mesmas medidas do render (memeLayout em @clipper/shared).
// Linha do tempo com as faixas vídeo, título, imagens, fundo e sons: arrastar move, as bordas aparam.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Copy, Star, Download, Film, Image as ImageIcon, Laugh, Loader2, Music, Pause, Play, Plus, Scissors, Subtitles, Trash2, Type, UploadCloud, Volume2, Wand2, X, ZoomIn, ZoomOut } from 'lucide-react';
import {
  clipLength,
  clipOffsets,
  cueKey,
  formatBytes,
  MEME_H,
  MEME_LAYOUT,
  MEME_W,
  memeDuration,
  memeLayout,
  titleVisible,
  wrapMemeText,
  type Job,
  type MemeBrand,
  type MemeClip,
  type MemeProject,
} from '@clipper/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select } from '@/components/ui/select';
import { Skeleton, SkeletonVideo } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { JobStatusBadge, stepLabel } from '@/components/job-status';
import { api, fileUrl, uploadFile, usePolling } from '@/lib/client';
import { cn } from '@/lib/utils';

interface Overview {
  /** data/input: os vídeos do compilado guardam só o nome do arquivo. */
  inputDir: string;
  projects: MemeProject[];
  brand: MemeBrand;
  jobs: Job[];
}
interface InputFile {
  name: string;
  size: number;
}
interface Asset {
  path: string;
  name: string;
  folder: string;
  kind: 'image' | 'audio';
  uploaded: boolean;
}
type Sel = { kind: 'clip' | 'image' | 'sfx' | 'span'; id: string } | { kind: 'music' } | null;

const GRAD = 'bg-gradient-to-r from-[#5b2a6e] to-[#e07a3a] text-white hover:opacity-90';
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const joinPath = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}${name}`;
/** Índice do último início <= t. */
const lastIndexAt = (offsets: number[], t: number) => {
  let i = 0;
  offsets.forEach((o, k) => t >= o - 1e-6 && (i = k));
  return i;
};
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

/** Upload de logo/imagem/som para data/meme-studio/assets (XHR, com progresso). */
function uploadAsset(file: File, onProgress: (p: number) => void): Promise<{ path: string; kind: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/memes/assets');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const body = JSON.parse(xhr.responseText || '{}');
      xhr.status < 300 ? resolve(body) : reject(new Error(body.error ?? `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Falha de rede no upload'));
    xhr.send(file);
  });
}

const imageAspect = (src: string) =>
  new Promise<number>((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve(img.naturalWidth / Math.max(1, img.naturalHeight));
    img.onerror = () => resolve(1);
    img.src = src;
  });
const audioDuration = (src: string) =>
  new Promise<number>((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => resolve(Number.isFinite(a.duration) ? a.duration : 3);
    a.onerror = () => resolve(3);
    a.src = src;
  });

export function MemeStudio() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get('p');
  const { data, refresh } = usePolling(() => api<Overview>('/api/memes'), 2500);
  // jobIds dos renders já favoritados (para a estrela dos cards)
  const [favJobs, setFavJobs] = useState<Set<string>>(new Set());
  useEffect(() => {
    api<{ favorites: { jobId: string }[] }>('/api/favorites')
      .then((r) => setFavJobs(new Set(r.favorites.map((f) => f.jobId))))
      .catch(() => undefined);
  }, []);

  const create = async () => {
    const { project } = await api<{ project: MemeProject }>('/api/memes', { method: 'POST', body: '{}' });
    await refresh();
    router.push(`/memes?p=${project.id}`);
  };

  const project = data?.projects.find((p) => p.id === id) ?? null;
  if (data && project) {
    return (
      <MemeEditor
        key={project.id}
        initial={project}
        projects={data.projects}
        onCreate={create}
        inputDir={data.inputDir}
        brand={data.brand}
        jobs={data.jobs.filter((j) => j.settings.meme?.projectId === project.id)}
        onChanged={refresh}
      />
    );
  }
  return (
    <div className="space-y-6 pb-16">
      <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-[#2a1140] via-[#5b2a6e] to-[#e07a3a] p-6">
        <div className="flex flex-wrap items-center gap-4">
          <span className="grid size-12 place-items-center rounded-xl bg-white/10 text-white">
            <Film className="size-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold uppercase tracking-wide text-white">Editor de vídeo</h1>
            <p className="text-sm text-white/75">Compilado de 3 a 6 vídeos engraçados no molde do canal. Edição na mão; a IA só traduz as legendas.</p>
          </div>
          <Button size="lg" className="bg-white/15 text-white hover:bg-white/25" onClick={create}>
            <Plus /> Novo compilado
          </Button>
        </div>
      </section>
      {!data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="overflow-hidden rounded-xl border bg-card">
              <Skeleton className="aspect-video w-full rounded-none" />
              <div className="space-y-2 p-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {data.projects.map((p) => (
            <ProjectCard
              key={p.id}
              p={p}
              inputDir={data.inputDir}
              favorited={!!p.lastRender && favJobs.has(p.lastRender.jobId)}
              onFavorite={async () => {
                await api('/api/favorites/edited', { method: 'POST', body: JSON.stringify({ kind: 'meme', projectId: p.id }) });
                setFavJobs((s) => new Set([...s, p.lastRender!.jobId]));
              }}
              onOpen={() => router.push(`/memes?p=${p.id}`)}
              onCopy={async () => {
                await api('/api/memes', { method: 'POST', body: JSON.stringify({ copyOf: p.id }) });
                refresh();
              }}
              onDelete={async () => {
                if (!confirm(`Apagar "${p.title || p.name}"? Os vídeos originais em data/input continuam lá.`)) return;
                await api(`/api/memes/${p.id}`, { method: 'DELETE' });
                refresh();
              }}
            />
          ))}
          {!data.projects.length && <p className="col-span-full py-10 text-center text-sm text-muted-foreground">Nenhum compilado ainda. Crie um novo.</p>}
        </div>
      )}
    </div>
  );
}

/** Card do projeto: prévia pequena (render final, senão o 1º vídeo, senão imagem genérica) que toca ao passar o mouse. */
function ProjectCard({ p, inputDir, favorited, onFavorite, onOpen, onCopy, onDelete }: { p: MemeProject; inputDir: string; favorited: boolean; onFavorite: () => void; onOpen: () => void; onCopy: () => void; onDelete: () => void }) {
  const v = useRef<HTMLVideoElement>(null);
  const first = p.clips[0];
  const src = p.lastRender?.video ? fileUrl(p.lastRender.video) : first ? `${fileUrl(joinPath(inputDir, first.file))}#t=${first.start.toFixed(1)}` : null;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      onMouseEnter={() => v.current?.play().catch(() => undefined)}
      onMouseLeave={() => v.current?.pause()}
      className="group cursor-pointer overflow-hidden rounded-xl border bg-card text-left transition-all duration-200 hover:-translate-y-1 hover:border-[#e07a3a] hover:shadow-lg hover:shadow-[#e07a3a]/20"
    >
      <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-[#2a1140] via-[#5b2a6e] to-[#e07a3a]">
        {/* Imagem genérica por baixo: aparece quando não há vídeo ou o navegador não consegue tocá-lo */}
        <div className="absolute inset-0 grid place-items-center text-white/70">
          <Film className="size-10 transition-transform duration-300 group-hover:scale-110" />
        </div>
        {src && (
          <SkeletonVideo
            ref={v}
            src={src}
            muted
            loop
            playsInline
            preload="metadata"
            onError={(e) => (e.currentTarget.style.display = 'none')}
            wrapperClassName="absolute inset-0"
            className={cn('size-full transition-transform duration-300 group-hover:scale-105', p.lastRender ? 'bg-black object-contain' : 'object-cover')}
          />
        )}
        {p.lastRender && <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">Renderizado</span>}
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {p.lastRender && (
            <Button size="icon" variant="secondary" className="h-7 w-7 bg-black/60 text-white hover:bg-black/80" title={favorited ? 'Já está nos favoritos' : 'Favoritar o vídeo renderizado'} onClick={(e) => (e.stopPropagation(), !favorited && onFavorite())}>
              <Star className={cn('size-3.5', favorited && 'fill-yellow-400 text-yellow-400')} />
            </Button>
          )}
          {p.lastRender?.video ? (
            <a href={fileUrl(p.lastRender.video, true)} onClick={(e) => e.stopPropagation()} title="Baixar o vídeo renderizado" className="grid h-7 w-7 place-items-center rounded-md bg-black/60 text-white hover:bg-[#e07a3a]">
              <Download className="size-3.5" />
            </a>
          ) : (
            <span title="Renderize o compilado para poder baixar" className="grid h-7 w-7 cursor-not-allowed place-items-center rounded-md bg-black/40 text-white/40">
              <Download className="size-3.5" />
            </span>
          )}
          <Button size="icon" variant="secondary" className="h-7 w-7 bg-black/60 text-white hover:bg-black/80" title="Duplicar" onClick={(e) => (e.stopPropagation(), onCopy())}>
            <Copy className="size-3.5" />
          </Button>
          <Button size="icon" variant="secondary" className="h-7 w-7 bg-black/60 text-white hover:bg-red-600" title="Apagar" onClick={(e) => (e.stopPropagation(), onDelete())}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="p-3">
        <div className="truncate font-medium transition-colors group-hover:text-[#e07a3a]">{p.title || p.name}</div>
        <div className="text-xs text-muted-foreground">
          {p.clips.length} vídeo(s) · {fmt(memeDuration(p))}
        </div>
      </div>
    </div>
  );
}

function MemeEditor({ initial, projects, onCreate, inputDir, brand: brand0, jobs, onChanged }: { initial: MemeProject; projects: MemeProject[]; onCreate: () => void; inputDir: string; brand: MemeBrand; jobs: Job[]; onChanged: () => void }) {
  const router = useRouter();
  const [p, setP] = useState<MemeProject>(initial);
  const [brand, setBrand] = useState<MemeBrand>(brand0);
  const [sel, setSel] = useState<Sel>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | string>('idle');
  const dirty = useRef(false);

  // Legendas e último render são gravados pelo worker: atualiza só esses campos
  useEffect(() => {
    setP((cur) => ({ ...cur, cues: initial.cues, lastRender: initial.lastRender }));
  }, [initial.cues, initial.lastRender]);

  const update = useCallback((fn: (p: MemeProject) => MemeProject) => {
    dirty.current = true;
    setP((cur) => fn(cur));
  }, []);

  // Salva sozinho (600ms depois da última mudança)
  useEffect(() => {
    if (!dirty.current) return;
    const tm = setTimeout(async () => {
      setSaving('saving');
      try {
        const { cues: _c, lastRender: _l, id: _i, createdAt: _a, updatedAt: _u, ...body } = p;
        const r = await api<{ project: MemeProject }>(`/api/memes/${p.id}`, { method: 'PUT', body: JSON.stringify(body) });
        dirty.current = false;
        setP((cur) => ({ ...cur, updatedAt: r.project.updatedAt }));
        setSaving('saved');
      } catch (e) {
        setSaving((e as Error).message);
      }
    }, 600);
    return () => clearTimeout(tm);
  }, [p]);

  // Molde salvo com atraso (sliders mandam muitas mudanças); a API devolve o primeiro quadro da logo parada
  const brandTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveBrand = (b: MemeBrand) => {
    setBrand(b);
    clearTimeout(brandTimer.current);
    brandTimer.current = setTimeout(async () => {
      const r = await api<{ brand: MemeBrand }>('/api/memes/brand', { method: 'PUT', body: JSON.stringify(b) }).catch(() => null);
      if (r) setBrand((cur) => ({ ...cur, logoStillFile: r.brand.logoStillFile }));
    }, 400);
  };

  const total = memeDuration(p);
  useEffect(() => {
    if (t > total) setT(total);
  }, [t, total]);

  const job = jobs[0] ?? null;
  const running = jobs.find((j) => j.status === 'pending' || j.status === 'processing');
  const lastDone = useRef<string | null>(null);
  useEffect(() => {
    if (job?.status === 'completed' && lastDone.current !== job.id) {
      lastDone.current = job.id;
      onChanged();
    }
  }, [job, onChanged]);

  const startJob = async (action: 'transcribe' | 'render') => {
    try {
      await api(`/api/memes/${p.id}/job`, { method: 'POST', body: JSON.stringify({ action }) });
      onChanged();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const remove = async () => {
    if (!confirm('Excluir este compilado? (os vídeos em data/input continuam lá)')) return;
    await api(`/api/memes/${p.id}`, { method: 'DELETE' });
    onChanged();
    router.push('/memes');
  };

  // Atalhos: espaço toca/pausa, Delete remove o item selecionado
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((v) => !v);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        removeSel(sel);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const removeSel = (s: Sel) => {
    if (!s) return;
    update((cur) => ({
      ...cur,
      clips: s.kind === 'clip' ? cur.clips.filter((c) => c.id !== s.id) : cur.clips,
      images: s.kind === 'image' ? cur.images.filter((c) => c.id !== s.id) : cur.images,
      sfx: s.kind === 'sfx' ? cur.sfx.filter((c) => c.id !== s.id) : cur.sfx,
      titleSpans: s.kind === 'span' ? cur.titleSpans.filter((c) => c.id !== s.id) : cur.titleSpans,
      music: s.kind === 'music' ? null : cur.music,
    }));
    setSel(null);
  };

  /** Divide o vídeo sob o cursor em dois (para tirar um pedaço do meio de um vídeo maior). */
  const split = () => {
    const offs = clipOffsets(p.clips);
    const i = p.clips.findIndex((c, k) => t > offs[k] + 0.3 && t < offs[k] + clipLength(c) - 0.3);
    if (i < 0) return;
    const c = p.clips[i];
    const cut = c.start + (t - offs[i]);
    update((cur) => ({ ...cur, clips: [...cur.clips.slice(0, i), { ...c, end: cut }, { ...c, id: uid(), start: cut }, ...cur.clips.slice(i + 1)] }));
  };

  const [tab, setTab] = useState<'videos' | 'media' | 'molde' | 'texto'>('videos');
  const [zoom, setZoom] = useState(1);
  const stale = !!p.lastRender && p.updatedAt > p.lastRender.at;
  const tabs = [
    { key: 'videos', label: 'Vídeos', icon: <Film /> },
    { key: 'media', label: 'Mídia', icon: <ImageIcon /> },
    { key: 'texto', label: 'Texto', icon: <Type /> },
    { key: 'molde', label: 'Molde', icon: <Wand2 /> },
  ] as const;

  return (
    // Editor de tela cheia (abaixo do menu): sem rolar a página, cada coluna rola por dentro
    <div className="fixed inset-x-0 bottom-0 top-14 z-10 flex flex-col gap-2 bg-background p-2">
      <div className="flex shrink-0 items-center gap-2">
        <Select className="h-8 w-56 text-xs" value={p.id} onChange={(e) => router.push(`/memes?p=${e.target.value}`)} aria-label="Compilado">
          {projects.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title || x.name}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="outline" onClick={onCreate} title="Novo compilado">
          <Plus />
        </Button>
        <Input className="h-8 w-56 text-xs" value={p.name} onChange={(e) => update((c) => ({ ...c, name: e.target.value }))} aria-label="Nome do compilado" />
        <span className="text-xs text-muted-foreground">{saving === 'saving' ? 'Salvando…' : saving === 'saved' ? 'Salvo' : saving === 'idle' ? '' : `Erro ao salvar: ${saving}`}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={remove}>
            <Trash2 /> Excluir compilado
          </Button>
          <Button size="sm" className={GRAD} disabled={!p.clips.length || !!running} onClick={() => startJob('render')} title="Gera o MP4 final em data/output/memes">
            {running?.settings.meme?.action === 'render' ? <Loader2 className="animate-spin" /> : <Film />} Renderizar vídeo final
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_300px] gap-2">
        {/* esquerda: abas */}
        <div className="flex min-h-0 flex-col rounded-xl border bg-card">
          <div className="grid shrink-0 grid-cols-4 gap-1 border-b p-1.5">
            {tabs.map((x) => (
              <button
                key={x.key}
                onClick={() => setTab(x.key)}
                className={cn('flex flex-col items-center gap-0.5 rounded-md py-1.5 text-[11px] [&_svg]:size-4', tab === x.key ? 'bg-gradient-to-br from-[#5b2a6e] to-[#e07a3a] text-white' : 'text-muted-foreground hover:bg-accent')}
              >
                {x.icon}
                {x.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {tab === 'videos' && <ClipsPanel p={p} update={update} sel={sel} onSelect={setSel} />}
            {tab === 'media' && <AssetsPanel p={p} t={t} update={update} setSel={setSel} />}
            {tab === 'texto' && (
              <>
                <TitlePanel p={p} update={update} t={t} setSel={setSel} />
                <SubtitlesPanel p={p} update={update} running={running} startJob={startJob} />
              </>
            )}
            {tab === 'molde' && <BrandPanel brand={brand} onChange={saveBrand} />}
          </div>
        </div>

        {/* centro: prévia com zoom */}
        <div className="flex min-h-0 flex-col rounded-xl border bg-black/30">
          <Stage p={p} inputDir={inputDir} brand={brand} zoom={zoom} t={t} setT={setT} playing={playing} setPlaying={setPlaying} sel={sel} setSel={setSel} update={update} />
          <div className="flex shrink-0 items-center justify-center gap-2 border-t p-1.5">
            <Button size="sm" variant="secondary" onClick={() => setPlaying((v) => !v)} disabled={!p.clips.length}>
              {playing ? <Pause /> : <Play />} {playing ? 'Pausar' : 'Tocar'}
            </Button>
            <span className="w-28 text-center font-mono text-xs tabular-nums">
              {fmt(t)} / {fmt(total)}
            </span>
            <Button variant="outline" size="sm" onClick={split} disabled={!p.clips.length} title="Divide o vídeo no ponto do cursor">
              <Scissors /> Dividir aqui
            </Button>
            <span className="mx-2 h-5 w-px bg-border" />
            <Button size="icon" variant="ghost" onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))} title="Diminuir prévia">
              <ZoomOut />
            </Button>
            <button className="w-12 text-xs tabular-nums text-muted-foreground hover:text-foreground" onClick={() => setZoom(1)} title="Ajustar à tela">
              {Math.round(zoom * 100)}%
            </button>
            <Button size="icon" variant="ghost" onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(2)))} title="Aumentar prévia">
              <ZoomIn />
            </Button>
          </div>
        </div>

        {/* direita: item selecionado + vídeo final */}
        <div className="min-h-0 space-y-2 overflow-y-auto">
          <Inspector p={p} sel={sel} update={update} remove={() => removeSel(sel)} />
          {!sel && <p className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">Clique num vídeo, imagem, som ou trecho (na prévia ou na linha do tempo) para ajustar aqui.</p>}
          <RenderPanel p={p} job={job} stale={stale} />
        </div>
      </div>

      <Timeline p={p} t={t} setT={(v) => (setPlaying(false), setT(v))} sel={sel} setSel={setSel} update={update} remove={removeSel} />
    </div>
  );
}

/* ------------------------------------------------------------------ prévia */

function Stage({ p, inputDir, brand, zoom, t, setT, playing, setPlaying, sel, setSel, update }: {
  p: MemeProject;
  inputDir: string;
  brand: MemeBrand;
  zoom: number;
  t: number;
  setT: (t: number) => void;
  playing: boolean;
  setPlaying: (v: boolean) => void;
  sel: Sel;
  setSel: (s: Sel) => void;
  update: (fn: (p: MemeProject) => MemeProject) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0.35);
  const scale = fit * zoom;
  const videos = useRef<Record<string, HTMLVideoElement | null>>({});
  const music = useRef<HTMLAudioElement>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const offsets = useMemo(() => clipOffsets(p.clips), [p.clips]);
  const total = memeDuration(p);
  const idx = lastIndexAt(offsets, t);
  const clip = p.clips[Math.min(idx, p.clips.length - 1)] as MemeClip | undefined;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // Cabe inteira na área (100%); o zoom aumenta/diminui a partir daí
    const ro = new ResizeObserver(() => setFit(Math.max(0.05, Math.min((el.clientWidth - 24) / MEME_W, (el.clientHeight - 24) / MEME_H))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Relógio: tocando, o vídeo ativo manda no tempo; pausado, cada vídeo vai para o quadro do cursor
  useEffect(() => {
    if (!playing) {
      Object.values(videos.current).forEach((v) => v?.pause());
      music.current?.pause();
      return;
    }
    if (tRef.current >= total - 0.05) setT(0);
    let raf = 0;
    let last = performance.now();
    let cur = tRef.current;
    const sfxPlayed = new Set<string>();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const i = lastIndexAt(offsets, cur);
      const c = p.clips[i];
      if (!c) return setPlaying(false);
      const v = videos.current[c.id];
      if (v && !v.paused && v.readyState >= 2) cur = offsets[i] + (v.currentTime - c.start);
      else cur += dt;
      if (cur >= offsets[i] + clipLength(c) - 0.01) {
        v?.pause();
        cur = offsets[i] + clipLength(c) + 0.001;
        if (i === p.clips.length - 1) {
          setT(total);
          setPlaying(false);
          return;
        }
      }
      const j = lastIndexAt(offsets, cur);
      const cj = p.clips[j];
      const vj = videos.current[cj.id];
      if (vj) {
        const want = cj.start + (cur - offsets[j]);
        if (vj.paused) {
          vj.currentTime = want;
          vj.volume = Math.min(1, cj.volume);
          void vj.play().catch(() => undefined);
        } else if (Math.abs(vj.currentTime - want) > 0.35) vj.currentTime = want;
      }
      // Fundo: em loop, a partir do offset
      const m = music.current;
      if (m && p.music && Number.isFinite(m.duration) && m.duration > 0) {
        const want = (p.music.offset + cur) % m.duration;
        if (m.paused) {
          m.currentTime = want;
          void m.play().catch(() => undefined);
        } else if (Math.abs(m.currentTime - want) > 0.4) m.currentTime = want;
        m.volume = Math.min(1, p.music.volume);
      }
      for (const s of p.sfx) {
        if (!sfxPlayed.has(s.id) && cur >= s.at && cur < s.at + 0.25) {
          sfxPlayed.add(s.id);
          const a = new Audio(fileUrl(s.file));
          a.volume = Math.min(1, s.volume);
          void a.play().catch(() => undefined);
          setTimeout(() => a.pause(), s.duration * 1000);
        }
      }
      tRef.current = cur;
      setT(cur);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      Object.values(videos.current).forEach((v) => v?.pause());
      music.current?.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // Pausado: posiciona o vídeo ativo no quadro do cursor
  useEffect(() => {
    if (playing || !clip) return;
    const v = videos.current[clip.id];
    if (v) {
      const want = clip.start + (t - offsets[idx]);
      if (Math.abs(v.currentTime - want) > 0.03) v.currentTime = want;
    }
  }, [t, playing, clip, idx, offsets]);

  // Lives baixadas costumam ser MPEG-TS com extensão .mp4 (o navegador não toca): usa a cópia leve de /api/inputs/preview
  const [playable, setPlayable] = useState<Record<string, string>>({});
  const files = [...new Set(p.clips.map((c) => c.file))].join('|');
  useEffect(() => {
    for (const f of files.split('|').filter(Boolean)) {
      if (playable[f]) continue;
      api<{ path: string }>(`/api/inputs/preview?name=${encodeURIComponent(f)}`)
        .then((r) => setPlayable((m) => ({ ...m, [f]: r.path })))
        .catch(() => setPlayable((m) => ({ ...m, [f]: joinPath(inputDir, f) })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, inputDir]);

  // Fundo com o áudio de um vídeo de data/input: mesma cópia tocável
  const musicFile = p.music?.file ?? '';
  const fromInput = !!musicFile && musicFile.replace(/\\/g, '/').startsWith(inputDir.replace(/\\/g, '/'));
  const musicName = musicFile.split(/[\\/]/).pop() ?? '';
  const musicSrc = !musicFile ? '' : fromInput ? (playable[musicName] ?? '') : musicFile;
  useEffect(() => {
    if (!fromInput || playable[musicName]) return;
    api<{ path: string }>(`/api/inputs/preview?name=${encodeURIComponent(musicName)}`)
      .then((r) => setPlayable((m) => ({ ...m, [musicName]: r.path })))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromInput, musicName]);

  const titleOn = titleVisible(p, t);
  const lay = memeLayout(brand, p.title, clip?.width ?? 16, clip?.height ?? 9);
  const tl = lay.title;
  const R = brand.radius * MEME_W;
  const B = brand.showFrame ? Math.max(2, Math.round(MEME_LAYOUT.border * MEME_W)) : 0;
  const cue = clip && p.subtitles ? (p.cues[cueKey(clip)] ?? []).find((q) => t - offsets[idx] >= q.start && t - offsets[idx] < q.end) : null;
  const cSize = MEME_LAYOUT.captionSize * MEME_W;
  const logoSrc = brand.logoStill && brand.logoStillFile ? brand.logoStillFile : brand.logo;

  /** Arrastar imagem na prévia: corpo move, canto redimensiona. */
  const dragImage = (e: React.PointerEvent, id: string, mode: 'move' | 'size') => {
    e.stopPropagation();
    e.preventDefault();
    setSel({ kind: 'image', id });
    const im = p.images.find((x) => x.id === id);
    if (!im) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const k = 1 / (scale * MEME_W);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) * k;
      const dy = ((ev.clientY - sy) * k * MEME_W) / MEME_H;
      update((cur) => ({
        ...cur,
        images: cur.images.map((x) => (x.id !== id ? x : mode === 'move' ? { ...x, x: clamp(im.x + dx, 0, 1), y: clamp(im.y + dy, 0, 1) } : { ...x, w: clamp(im.w + dx * 2, 0.05, 1.2) })),
      }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div ref={wrap} className="grid min-h-0 flex-1 place-items-center overflow-auto p-3">
      <div className="relative shrink-0 overflow-hidden rounded-xl border border-white/10 shadow-2xl shadow-black/50" style={{ width: MEME_W * scale, height: MEME_H * scale, background: brand.background }} onClick={() => setSel(null)}>
        <div className="absolute left-0 top-0 origin-top-left" style={{ width: MEME_W, height: MEME_H, transform: `scale(${scale})` }}>
          {/* logo */}
          {lay.logo && logoSrc && (
            <div className="absolute flex items-center justify-center" style={{ left: lay.logo.x0 * MEME_W, top: lay.logo.y0 * MEME_H, width: lay.logo.w * MEME_W, height: lay.logo.h * MEME_H }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fileUrl(logoSrc)} alt="logo" className="size-full object-contain" />
            </div>
          )}
          {!brand.logo && brand.logoPos !== 'hidden' && (
            <div className="absolute left-1/2 grid -translate-x-1/2 place-items-center rounded-2xl border-4 border-dashed border-white/20 text-4xl text-white/30" style={{ top: MEME_LAYOUT.margin * MEME_H, height: brand.logoSize * MEME_H, width: MEME_W * 0.5 }}>
              LOGO (aba Molde)
            </div>
          )}
          {/* título */}
          {titleOn && (
            <div
              className="absolute inset-x-0 flex items-center justify-center text-center"
              style={{
                top: tl.y0 * MEME_H,
                height: tl.h * MEME_H,
                fontFamily: '"Arial Black", Arial, sans-serif',
                fontWeight: 900,
                fontSize: tl.size * MEME_W,
                lineHeight: 1.18,
                color: brand.titleColor,
                textShadow: '4px 4px 0 rgba(0,0,0,.6)',
              }}
            >
              <div>
                {tl.lines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            </div>
          )}
          {/* vídeos (um elemento por vídeo, só o ativo aparece) */}
          {p.clips.map((c, i) => {
            const b = memeLayout(brand, p.title, c.width, c.height).video;
            const w = Math.round((b.w * MEME_W) / 2) * 2;
            const h = Math.round((b.h * MEME_H) / 2) * 2;
            const x = Math.round(b.x0 * MEME_W + (b.w * MEME_W - w) / 2);
            const y = Math.round(b.y0 * MEME_H);
            return (
              <div key={c.id} className="absolute" style={{ left: x - B, top: y - B, width: w + 2 * B, height: h + 2 * B, borderRadius: R + B, background: B ? brand.frame : 'transparent', visibility: i === idx ? 'visible' : 'hidden' }}>
                {!playable[c.file] && <span className="absolute inset-0 grid place-items-center text-4xl text-white/70">Preparando prévia…</span>}
                <video
                  ref={(el) => {
                    videos.current[c.id] = el;
                  }}
                  src={playable[c.file] ? fileUrl(playable[c.file]) : undefined}
                  preload="auto"
                  playsInline
                  className="absolute object-cover"
                  style={{ left: B, top: B, width: w, height: h, borderRadius: R }}
                  onLoadedMetadata={(e) => {
                    if (i === idx && !playing) e.currentTarget.currentTime = c.start + (t - offsets[i]);
                  }}
                />
              </div>
            );
          })}
          {!p.clips.length && (
            <div className="absolute grid place-items-center rounded-[48px] border-4 border-dashed border-white/15 text-5xl text-white/30" style={{ left: 0.05 * MEME_W, top: 0.26 * MEME_H, width: 0.9 * MEME_W, height: 0.4 * MEME_H }}>
              Adicione vídeos
            </div>
          )}
          {/* legenda */}
          {cue && (
            <div
              className="absolute inset-x-[40px] text-center uppercase"
              style={{
                bottom: MEME_H - lay.captionY * MEME_H,
                fontFamily: '"Arial Black", Arial, sans-serif',
                fontWeight: 900,
                fontSize: cSize,
                lineHeight: 1.15,
                color: '#fff',
                WebkitTextStroke: `${Math.round(cSize * 0.2)}px #000`,
                paintOrder: 'stroke fill',
                textShadow: '2px 2px 0 rgba(0,0,0,.6)',
              }}
            >
              {wrapMemeText(cue.text.toUpperCase(), 24)
                .slice(0, 2)
                .map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
            </div>
          )}
          {/* imagens por cima */}
          {p.images
            .filter((im) => t >= im.at && t < im.at + im.duration)
            .map((im) => {
              const w = im.w * MEME_W;
              const h = w / (im.aspect || 1);
              const on = sel?.kind === 'image' && sel.id === im.id;
              return (
                <div
                  key={im.id}
                  className={cn('absolute cursor-move touch-none', on && 'outline outline-[6px] outline-amber-400')}
                  style={{ left: im.x * MEME_W - w / 2, top: im.y * MEME_H - h / 2, width: w, height: h }}
                  onPointerDown={(e) => dragImage(e, im.id, 'move')}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fileUrl(im.file)} alt="" draggable={false} className="size-full select-none" />
                  {on && <span className="absolute -bottom-6 -right-6 size-12 cursor-nwse-resize rounded-full border-4 border-white bg-amber-400" onPointerDown={(e) => dragImage(e, im.id, 'size')} />}
                </div>
              );
            })}
        </div>
      </div>
      {musicSrc && <audio ref={music} src={fileUrl(musicSrc)} preload="auto" />}
    </div>
  );
}


/* ------------------------------------------------------------------ painéis */

function Panel({ title, icon, children, right }: { title: string; icon: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <span className="grid size-6 place-items-center rounded-md bg-gradient-to-br from-[#5b2a6e] to-[#e07a3a] text-white [&_svg]:size-3.5">{icon}</span>
        {title}
        <span className="ml-auto">{right}</span>
      </div>
      {children}
    </section>
  );
}

function ClipsPanel({ p, update, sel, onSelect }: { p: MemeProject; update: (fn: (p: MemeProject) => MemeProject) => void; sel: Sel; onSelect: (s: Sel) => void }) {
  const { data, refresh } = usePolling(() => api<{ files: InputFile[]; dir: string }>('/api/inputs'), 10000);
  const [upload, setUpload] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const removeFile = async (name: string, used: number) => {
    if (used) return alert(`"${name}" está ${used}× neste compilado. Tire do compilado antes de apagar o arquivo.`);
    const warn = '';
    if (!confirm(`Apagar "${name}" de vez? O arquivo sai da pasta data/input e não dá para desfazer.${warn}`)) return;
    try {
      await api(`/api/inputs?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (used) update((c) => ({ ...c, clips: c.clips.filter((x) => x.file !== name) }));
      refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  };
  const add = async (name: string) => {
    const info = await api<{ duration: number; width: number; height: number; hasAudio: boolean }>(`/api/memes/probe?file=${encodeURIComponent(name)}`);
    const id = uid();
    // Vídeo grande: entra só o começo (apare depois na linha do tempo ou divida)
    const end = info.duration > 60 ? 15 : info.duration;
    update((c) => ({ ...c, clips: [...c.clips, { id, file: name, start: 0, end, sourceDuration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio, volume: 1 }] }));
    onSelect({ kind: 'clip', id });
  };

  const onFiles = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      setUpload(0);
      try {
        const r = await uploadFile(f, setUpload);
        await refresh();
        await add(r.name);
      } catch (e) {
        alert((e as Error).message);
      }
    }
    setUpload(null);
  };

  const files = (data?.files ?? []).filter((f) => f.name.toLowerCase().includes(filter.toLowerCase()));
  const move = (i: number, d: number) =>
    update((cur) => {
      const arr = [...cur.clips];
      const j = clamp(i + d, 0, arr.length - 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...cur, clips: arr };
    });
  return (
    <>
    <Panel title="No compilado" icon={<Film />} right={<span className={cn('text-xs', p.clips.length >= 3 && p.clips.length <= 6 ? 'text-emerald-400' : 'text-muted-foreground')}>{p.clips.length} de 3–6</span>}>
      <div className="space-y-1">
        {p.clips.map((c, i) => (
          <div
            key={c.id}
            onClick={() => onSelect({ kind: 'clip', id: c.id })}
            className={cn('flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1.5 text-xs', sel?.kind === 'clip' && sel.id === c.id ? 'border-amber-400 bg-amber-400/10' : 'border-transparent bg-muted/40 hover:bg-accent')}
          >
            <span className="w-4 shrink-0 text-center font-semibold text-[#e07a3a]">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{c.file}</span>
              <span className="text-[10px] text-muted-foreground">
                {clipLength(c).toFixed(1)}s · {c.start.toFixed(1)}–{c.end.toFixed(1)}
              </span>
            </span>
            <button className="px-1 text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === 0} onClick={(e) => (e.stopPropagation(), move(i, -1))} title="Mover para antes">
              ↑
            </button>
            <button className="px-1 text-muted-foreground hover:text-foreground disabled:opacity-30" disabled={i === p.clips.length - 1} onClick={(e) => (e.stopPropagation(), move(i, 1))} title="Mover para depois">
              ↓
            </button>
            <button
              className="rounded p-1 text-muted-foreground hover:bg-red-500/20 hover:text-red-400"
              onClick={(e) => (e.stopPropagation(), update((cur) => ({ ...cur, clips: cur.clips.filter((x) => x.id !== c.id) })))}
              title="Tirar do compilado (o arquivo continua em data/input)"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
        {!p.clips.length && <p className="py-2 text-center text-xs text-muted-foreground">Nenhum vídeo ainda. Adicione abaixo.</p>}
      </div>
    </Panel>
    <Panel title="Adicionar vídeos" icon={<Plus />}>
      <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-white/20 p-3 text-sm text-muted-foreground hover:bg-accent">
        <UploadCloud className="size-4" /> {upload !== null ? `Enviando ${(upload * 100).toFixed(0)}%` : 'Enviar vídeos'}
        <input type="file" accept="video/*" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
      </label>
      <Input className="mt-3 h-8 text-xs" placeholder="Buscar em data/input…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="mt-2 space-y-1">
        {files.map((f) => {
          const n = p.clips.filter((c) => c.file === f.name).length;
          return (
            <div key={f.name} className="group flex items-center rounded-md hover:bg-accent">
              <button onClick={() => add(f.name)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs" title="Adicionar ao fim do compilado">
                <Plus className="size-3.5 shrink-0 text-[#e07a3a]" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                {n > 0 && <span className="rounded bg-[#5b2a6e] px-1.5 text-[10px] text-white">{n}×</span>}
                <span className="shrink-0 text-muted-foreground">{formatBytes(f.size)}</span>
              </button>
              <button onClick={() => removeFile(f.name, n)} className="mr-1 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-red-600 hover:text-white group-hover:opacity-100" title="Apagar o vídeo de vez (libera espaço)">
                <Trash2 className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </Panel>
    </>
  );
}

function BrandPanel({ brand, onChange }: { brand: MemeBrand; onChange: (b: MemeBrand) => void }) {
  const [up, setUp] = useState<number | null>(null);
  const onLogo = async (f: File | undefined) => {
    if (!f) return;
    setUp(0);
    try {
      const r = await uploadAsset(f, setUp);
      onChange({ ...brand, logo: r.path, logoAspect: await imageAspect(fileUrl(r.path)) });
    } catch (e) {
      alert((e as Error).message);
    }
    setUp(null);
  };
  const set = (patch: Partial<MemeBrand>) => onChange({ ...brand, ...patch });
  const slider = (label: string, k: 'logoSize' | 'titleScale' | 'videoWidth' | 'radius' | 'offsetY', min: number, max: number, step: number, show: (v: number) => string) => (
    <label className="block space-y-1 text-xs">
      <span className="flex justify-between text-muted-foreground">
        {label}
        <span className="tabular-nums text-foreground">{show(brand[k])}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={brand[k]} onChange={(e) => set({ [k]: Number(e.target.value) })} className="w-full accent-[#e07a3a]" />
    </label>
  );
  const seg = <T extends string>(value: T, options: [T, string][], on: (v: T) => void) => (
    <div className="grid gap-1 rounded-lg bg-muted p-1 text-xs" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map(([v, l]) => (
        <button key={v} onClick={() => on(v)} className={cn('rounded-md py-1.5', value === v ? 'bg-background font-medium shadow' : 'text-muted-foreground')}>
          {l}
        </button>
      ))}
    </div>
  );
  const color = (k: 'background' | 'frame' | 'titleColor', label: string) => (
    <label className="flex flex-col items-center gap-1 text-[11px] text-muted-foreground">
      <input type="color" value={brand[k]} onChange={(e) => onChange({ ...brand, [k]: e.target.value })} className="h-8 w-12 cursor-pointer rounded border-0 bg-transparent" />
      {label}
    </label>
  );
  return (
    <Panel title="Molde do canal" icon={<Wand2 />}>
      <p className="mb-3 text-xs text-muted-foreground">Logo e cores ficam guardadas para os próximos vídeos.</p>
      <div className="flex items-center gap-3">
        <div className="grid h-14 w-24 place-items-center overflow-hidden rounded-md border bg-black/30">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {brand.logo ? <img src={fileUrl(brand.logo)} alt="logo" className="max-h-full max-w-full object-contain" /> : <span className="text-[10px] text-muted-foreground">sem logo</span>}
        </div>
        <label className="cursor-pointer rounded-md border px-3 py-1.5 text-xs hover:bg-accent">
          {up !== null ? `Enviando ${(up * 100).toFixed(0)}%` : brand.logo ? 'Trocar logo' : 'Enviar logo'}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => onLogo(e.target.files?.[0])} />
        </label>
        {brand.logo && (
          <Button variant="ghost" size="icon" onClick={() => onChange({ ...brand, logo: null })} title="Tirar a logo">
            <Trash2 />
          </Button>
        )}
      </div>
      <div className="mt-4 space-y-3">
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">Posição da logo</span>
          {seg(brand.logoPos, [['top', 'Em cima'], ['bottom', 'Embaixo'], ['hidden', 'Oculta']], (v) => set({ logoPos: v }))}
        </div>
        {slider('Tamanho da logo', 'logoSize', 0.03, 0.25, 0.005, (v) => `${Math.round(v * 100)}%`)}
        {brand.logo && (
          <label className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground" title="Para GIF/APNG animado: usa só o primeiro quadro (evita animação com quadros cortados)">
              Logo parada (sem animação)
            </span>
            <Switch checked={brand.logoStill} onCheckedChange={(v) => set({ logoStill: v })} />
          </label>
        )}
        {slider('Tamanho do título', 'titleScale', 0.5, 1.8, 0.05, (v) => `${Math.round(v * 100)}%`)}
        {slider('Largura do vídeo', 'videoWidth', 0.4, 1, 0.01, (v) => `${Math.round(v * 100)}%`)}
        {slider('Descer tudo', 'offsetY', 0, 0.3, 0.005, (v) => `${Math.round(v * 100)}%`)}
        <label className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Moldura em volta do vídeo</span>
          <Switch checked={brand.showFrame} onCheckedChange={(v) => set({ showFrame: v })} />
        </label>
        {slider('Cantos arredondados', 'radius', 0, 0.1, 0.005, (v) => (v ? `${Math.round(v * 1000)}` : 'retos'))}
        <div className="flex justify-around pt-1">
          {color('background', 'Fundo')}
          {brand.showFrame && color('frame', 'Moldura')}
          {color('titleColor', 'Título')}
        </div>
      </div>
    </Panel>
  );
}

function TitlePanel({ p, update, t, setSel }: { p: MemeProject; update: (fn: (p: MemeProject) => MemeProject) => void; t: number; setSel: (s: Sel) => void }) {
  const addSpan = () => {
    const id = uid();
    const total = memeDuration(p);
    update((c) => ({ ...c, titleMode: 'spans', titleSpans: [...c.titleSpans, { id, at: Math.min(t, Math.max(0, total - 1)), end: Math.min(total, t + 3) }] }));
    setSel({ kind: 'span', id });
  };
  return (
    <Panel title="Título" icon={<Type />}>
      <textarea
        value={p.title}
        onChange={(e) => update((c) => ({ ...c, title: e.target.value }))}
        placeholder="Ex.: QUANDO A SEGUNDA-FEIRA CHEGA 😂"
        rows={2}
        maxLength={160}
        className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm"
      />
      <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-xs">
        {(['all', 'spans'] as const).map((m) => (
          <button key={m} onClick={() => update((c) => ({ ...c, titleMode: m }))} className={cn('rounded-md py-1.5', p.titleMode === m ? 'bg-background font-medium shadow' : 'text-muted-foreground')}>
            {m === 'all' ? 'Vídeo todo' : 'Só nos trechos'}
          </button>
        ))}
      </div>
      {p.titleMode === 'spans' && (
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>{p.titleSpans.length} trecho(s) na faixa Título</span>
          <Button size="sm" variant="outline" onClick={addSpan}>
            <Plus /> Trecho aqui
          </Button>
        </div>
      )}
    </Panel>
  );
}

function AssetsPanel({ p, t, update, setSel }: { p: MemeProject; t: number; update: (fn: (p: MemeProject) => MemeProject) => void; setSel: (s: Sel) => void }) {
  const { data, refresh } = usePolling(() => api<{ files: Asset[] }>('/api/memes/assets'), 15000);
  const inputs = usePolling(() => api<{ files: InputFile[]; dir: string }>('/api/inputs'), 30000).data;
  const [tab, setTab] = useState<'image' | 'audio'>('image');
  const [up, setUp] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const total = memeDuration(p);

  const addImage = async (file: string) => {
    const id = uid();
    const aspect = await imageAspect(fileUrl(file));
    update((c) => ({ ...c, images: [...c.images, { id, file, at: Math.min(t, Math.max(0, total - 0.5)), duration: 3, x: 0.5, y: 0.55, w: 0.45, aspect }] }));
    setSel({ kind: 'image', id });
  };
  const addSfx = async (file: string) => {
    const id = uid();
    const duration = Math.min(10, await audioDuration(fileUrl(file)));
    update((c) => ({ ...c, sfx: [...c.sfx, { id, file, at: Math.min(t, Math.max(0, total - 0.3)), volume: 0.9, duration }] }));
    setSel({ kind: 'sfx', id });
  };
  const setMusic = (file: string) => {
    update((c) => ({ ...c, music: { file, offset: 0, volume: c.music?.volume ?? 0.25 } }));
    setSel({ kind: 'music' });
  };
  const onUpload = async (f: File | undefined) => {
    if (!f) return;
    setUp(0);
    try {
      const r = await uploadAsset(f, setUp);
      await refresh();
      if (r.kind === 'image') await addImage(r.path);
    } catch (e) {
      alert((e as Error).message);
    }
    setUp(null);
  };
  const list = (data?.files ?? []).filter((f) => f.kind === tab && `${f.folder}/${f.name}`.toLowerCase().includes(q.toLowerCase())).slice(0, 120);
  return (
    <Panel title="Imagens e sons" icon={<ImageIcon />}>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-xs">
        {(['image', 'audio'] as const).map((k) => (
          <button key={k} onClick={() => setTab(k)} className={cn('rounded-md py-1.5', tab === k ? 'bg-background font-medium shadow' : 'text-muted-foreground')}>
            {k === 'image' ? 'Imagens' : 'Sons e músicas'}
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Input className="h-8 text-xs" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 text-xs hover:bg-accent">
          <UploadCloud className="size-3.5" /> {up !== null ? `${(up * 100).toFixed(0)}%` : 'Enviar'}
          <input type="file" accept={tab === 'image' ? 'image/*' : 'audio/*'} className="hidden" onChange={(e) => onUpload(e.target.files?.[0])} />
        </label>
      </div>
      {tab === 'image' ? (
        <div className="mt-2 grid max-h-56 grid-cols-4 gap-1.5 overflow-y-auto pr-1">
          {list.map((f) => (
            <button key={f.path} onClick={() => addImage(f.path)} title={`${f.folder}/${f.name} — inserir no cursor`} className="aspect-square overflow-hidden rounded-md border bg-black/30 hover:ring-2 hover:ring-[#e07a3a]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fileUrl(f.path)} alt={f.name} loading="lazy" className="size-full object-contain" />
            </button>
          ))}
          {!list.length && <p className="col-span-4 py-4 text-center text-xs text-muted-foreground">Nenhuma imagem. Envie uma ou coloque em data/images.</p>}
        </div>
      ) : (
        <div className="mt-2 max-h-56 space-y-0.5 overflow-y-auto pr-1">
          {list.map((f) => (
            <div key={f.path} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-accent">
              <button className="text-muted-foreground hover:text-foreground" title="Ouvir" onClick={() => void new Audio(fileUrl(f.path)).play()}>
                <Play className="size-3.5" />
              </button>
              <span className="min-w-0 flex-1 truncate" title={`${f.folder}/${f.name}`}>
                <span className="text-muted-foreground">{f.folder}/</span>
                {f.name}
              </span>
              <button onClick={() => addSfx(f.path)} className="rounded bg-[#5b2a6e]/70 px-1.5 py-0.5 text-[10px] text-white hover:bg-[#5b2a6e]" title="Efeito no cursor">
                + som
              </button>
              <button onClick={() => setMusic(f.path)} className="rounded bg-[#e07a3a]/70 px-1.5 py-0.5 text-[10px] text-white hover:bg-[#e07a3a]" title="Usar como áudio de fundo">
                fundo
              </button>
            </div>
          ))}
          {!list.length && <p className="py-4 text-center text-xs text-muted-foreground">Nenhum som. Envie um ou coloque em data/audio.</p>}
        </div>
      )}
      {tab === 'audio' && !!inputs?.files.length && (
        <div className="mt-2">
          <Label className="text-xs text-muted-foreground">Fundo com o áudio de outro vídeo</Label>
          <Select className="mt-1 h-8 text-xs" value="" onChange={(e) => e.target.value && setMusic(joinPath(inputs.dir, e.target.value))}>
            <option value="">Escolher vídeo de data/input…</option>
            {inputs.files.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </Select>
        </div>
      )}
    </Panel>
  );
}

function SubtitlesPanel({ p, update, running, startJob }: { p: MemeProject; update: (fn: (p: MemeProject) => MemeProject) => void; running?: Job; startJob: (a: 'transcribe' | 'render') => void }) {
  const done = p.clips.filter((c) => p.cues[cueKey(c)]).length;
  const blocks = p.clips.reduce((a, c) => a + (p.cues[cueKey(c)]?.length ?? 0), 0);
  return (
    <Panel title="Legenda da fala" icon={<Subtitles />} right={<Switch checked={p.subtitles} onCheckedChange={(v) => update((c) => ({ ...c, subtitles: v }))} />}>
      <p className="text-xs text-muted-foreground">
        Whisper local transcreve as falas; no render, a legenda sai queimada no vídeo e em SRT nos idiomas pt, en, es e zh.
      </p>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className={done === p.clips.length && p.clips.length ? 'text-emerald-400' : 'text-muted-foreground'}>
          {done}/{p.clips.length} vídeo(s) transcritos · {blocks} bloco(s)
        </span>
        <Button size="sm" variant="outline" disabled={!p.clips.length || !!running} onClick={() => startJob('transcribe')}>
          {running?.settings.meme?.action === 'transcribe' ? <Loader2 className="animate-spin" /> : <Subtitles />} Gerar legendas
        </Button>
      </div>
    </Panel>
  );
}

function RenderPanel({ p, job, stale }: { p: MemeProject; job: Job | null; stale: boolean }) {
  const r = p.lastRender;
  if (!job && !r) return null;
  return (
    <Panel title="Vídeo final (último render)" icon={<Film />} right={job && <JobStatusBadge status={job.status} />}>
      <p className="mb-2 text-[11px] text-muted-foreground">
        O MP4 pronto para postar. Edite pela prévia ao lado e clique em “Renderizar vídeo final” para gerar de novo.
      </p>
      {stale && <p className="mb-2 rounded-md bg-amber-500/15 px-2 py-1 text-[11px] text-amber-300">Você editou depois deste render — ele está desatualizado.</p>}
      {job && (job.status === 'pending' || job.status === 'processing') && (
        <div className="space-y-1">
          <Progress value={job.progress * 100} />
          <p className="text-xs text-muted-foreground">
            {job.settings.meme?.action === 'transcribe' ? 'Legendas' : 'Compilado'} · {stepLabel(job.step ?? '')} · {(job.progress * 100).toFixed(0)}%
          </p>
        </div>
      )}
      {job?.status === 'failed' && <p className="text-xs text-red-400">{job.error}</p>}
      {r && (
        <div className="mt-2 space-y-2">
          <video src={fileUrl(r.video)} controls className="mx-auto max-h-64 rounded-lg" />
          <div className="flex flex-wrap gap-1.5">
            <a href={fileUrl(r.video, true)} className="inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-[#5b2a6e] to-[#e07a3a] px-2.5 py-1 text-xs text-white">
              <Download className="size-3.5" /> MP4
            </a>
            {Object.entries(r.captions).map(([lang, f]) => (
              <a key={lang} href={fileUrl(f, true)} className="rounded-md border px-2 py-1 text-xs uppercase hover:bg-accent">
                {lang}.srt
              </a>
            ))}
          </div>
          <p className="break-all text-[10px] text-muted-foreground">{r.video}</p>
        </div>
      )}
    </Panel>
  );
}

function Inspector({ p, sel, update, remove }: { p: MemeProject; sel: Sel; update: (fn: (p: MemeProject) => MemeProject) => void; remove: () => void }) {
  if (!sel) return null;
  const num = (label: string, value: number, set: (v: number) => void, step = 0.1, min = 0, max = 9999) => (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input type="number" step={step} min={min} max={max} value={Number(value.toFixed(2))} onChange={(e) => set(clamp(Number(e.target.value) || 0, min, max))} className="h-7 w-24 text-right text-xs" />
    </label>
  );
  const range = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, show: (v: number) => string) => (
    <label className="block space-y-1 text-xs">
      <span className="flex justify-between text-muted-foreground">
        {label}
        <span className="tabular-nums text-foreground">{show(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} className="w-full accent-[#e07a3a]" />
    </label>
  );
  const vol = (value: number, set: (v: number) => void) => (
    <label className="flex items-center gap-2 text-xs">
      <Volume2 className="size-3.5 text-muted-foreground" />
      <input type="range" min={0} max={2} step={0.05} value={value} onChange={(e) => set(Number(e.target.value))} className="flex-1 accent-[#e07a3a]" />
      <span className="w-10 text-right tabular-nums">{Math.round(value * 100)}%</span>
    </label>
  );
  let body: React.ReactNode = null;
  let title = '';
  if (sel.kind === 'clip') {
    const i = p.clips.findIndex((c) => c.id === sel.id);
    const c = p.clips[i];
    if (!c) return null;
    const set = (patch: Partial<MemeClip>) => update((cur) => ({ ...cur, clips: cur.clips.map((x) => (x.id === c.id ? { ...x, ...patch } : x)) }));
    const move = (d: number) =>
      update((cur) => {
        const arr = [...cur.clips];
        const j = clamp(i + d, 0, arr.length - 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
        return { ...cur, clips: arr };
      });
    title = `Vídeo ${i + 1}: ${c.file}`;
    body = (
      <>
        {num('Início (s no arquivo)', c.start, (v) => set({ start: Math.min(v, c.end - 0.3) }), 0.1, 0, c.sourceDuration)}
        {num('Fim (s no arquivo)', c.end, (v) => set({ end: Math.max(v, c.start + 0.3) }), 0.1, 0, c.sourceDuration)}
        <p className="text-[11px] text-muted-foreground">
          Duração {clipLength(c).toFixed(1)}s de {c.sourceDuration.toFixed(1)}s · {c.width}×{c.height}
          {!c.hasAudio && ' · sem áudio'}
        </p>
        {c.hasAudio && vol(c.volume, (v) => set({ volume: v }))}
        <div className="flex gap-1">
          <Button size="sm" variant="outline" disabled={i === 0} onClick={() => move(-1)}>
            ← Antes
          </Button>
          <Button size="sm" variant="outline" disabled={i === p.clips.length - 1} onClick={() => move(1)}>
            Depois →
          </Button>
        </div>
      </>
    );
  } else if (sel.kind === 'image') {
    const im = p.images.find((x) => x.id === sel.id);
    if (!im) return null;
    const set = (patch: Partial<typeof im>) => update((cur) => ({ ...cur, images: cur.images.map((x) => (x.id === im.id ? { ...x, ...patch } : x)) }));
    title = 'Imagem';
    body = (
      <>
        {num('Entra em (s)', im.at, (v) => set({ at: v }))}
        {num('Duração (s)', im.duration, (v) => set({ duration: Math.max(0.1, v) }), 0.1, 0.1)}
        {num('Centro X (%)', im.x * 100, (v) => set({ x: v / 100 }), 1, 0, 100)}
        {num('Centro Y (%)', im.y * 100, (v) => set({ y: v / 100 }), 1, 0, 100)}
        {range('Tamanho', im.w, 0.05, 1.2, 0.01, (v) => set({ w: v }), (v) => `${Math.round(v * 100)}%`)}
        <p className="text-[11px] text-muted-foreground">Arraste a imagem na prévia; a bolinha do canto muda o tamanho.</p>
      </>
    );
  } else if (sel.kind === 'sfx') {
    const s = p.sfx.find((x) => x.id === sel.id);
    if (!s) return null;
    const set = (patch: Partial<typeof s>) => update((cur) => ({ ...cur, sfx: cur.sfx.map((x) => (x.id === s.id ? { ...x, ...patch } : x)) }));
    title = `Som: ${s.file.split(/[\\/]/).pop()}`;
    body = (
      <>
        {num('Toca em (s)', s.at, (v) => set({ at: v }))}
        {range('Duração', s.duration, 0.2, 10, 0.1, (v) => set({ duration: v }), (v) => `${v.toFixed(1)}s`)}
        {vol(s.volume, (v) => set({ volume: v }))}
      </>
    );
  } else if (sel.kind === 'span') {
    const s = p.titleSpans.find((x) => x.id === sel.id);
    if (!s) return null;
    const set = (patch: Partial<typeof s>) => update((cur) => ({ ...cur, titleSpans: cur.titleSpans.map((x) => (x.id === s.id ? { ...x, ...patch } : x)) }));
    title = 'Trecho do título';
    body = (
      <>
        {num('De (s)', s.at, (v) => set({ at: Math.min(v, s.end - 0.2) }))}
        {num('Até (s)', s.end, (v) => set({ end: Math.max(v, s.at + 0.2) }))}
      </>
    );
  } else if (sel.kind === 'music' && p.music) {
    const m = p.music;
    const set = (patch: Partial<typeof m>) => update((cur) => ({ ...cur, music: cur.music && { ...cur.music, ...patch } }));
    title = `Fundo: ${m.file.split(/[\\/]/).pop()}`;
    body = (
      <>
        {num('Começa no arquivo em (s)', m.offset, (v) => set({ offset: v }))}
        {vol(m.volume, (v) => set({ volume: v }))}
        <p className="text-[11px] text-muted-foreground">Toca em loop do início ao fim do compilado, com fade no final.</p>
      </>
    );
  }
  if (!body) return null;
  return (
    <section className="space-y-2 rounded-xl border border-[#e07a3a]/50 bg-[#e07a3a]/5 p-4">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={title}>
          {title}
        </span>
        <Button size="icon" variant="ghost" onClick={remove} title="Remover (Delete)">
          <Trash2 />
        </Button>
      </div>
      {body}
    </section>
  );
}

/* ------------------------------------------------------------------ linha do tempo */

const TRACK_H = 34;

function Timeline({ p, t, setT, sel, setSel, update, remove }: { p: MemeProject; t: number; setT: (t: number) => void; sel: Sel; setSel: (s: Sel) => void; update: (fn: (p: MemeProject) => MemeProject) => void; remove: (s: Sel) => void }) {
  const [pps, setPps] = useState(40);
  const total = memeDuration(p);
  const offsets = clipOffsets(p.clips);
  const width = Math.max(600, (total + 2) * pps);
  const scroller = useRef<HTMLDivElement>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  /** Arraste genérico: dx em segundos para `apply`. */
  const drag = (e: React.PointerEvent, s: Sel, apply: (dt: number) => void, onEnd?: (dt: number) => void) => {
    e.stopPropagation();
    e.preventDefault();
    setSel(s);
    const sx = e.clientX;
    let last = 0;
    const move = (ev: PointerEvent) => {
      last = (ev.clientX - sx) / pps;
      apply(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onEnd?.(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const seekFrom = (e: React.PointerEvent) => {
    const el = scroller.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const at = (x: number) => clamp((x - rect.left + el.scrollLeft - 96) / pps, 0, total);
    setT(at(e.clientX));
    const move = (ev: PointerEvent) => setT(at(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const isSel = (kind: string, id?: string) => sel?.kind === kind && (!id || ('id' in sel && sel.id === id));
  const block = 'absolute top-1 bottom-1 overflow-hidden rounded-md border text-[11px] leading-tight text-white select-none touch-none';
  const handle = (side: 'l' | 'r', onDown: (e: React.PointerEvent) => void) => (
    <span onPointerDown={onDown} className={cn('absolute inset-y-0 z-10 w-2 cursor-ew-resize bg-white/0 hover:bg-white/40', side === 'l' ? 'left-0' : 'right-0')} />
  );

  /** X para remover o bloco selecionado direto na linha do tempo. */
  const del = (s: Sel) =>
    isSel(s!.kind, s && 'id' in s ? s.id : undefined) && (
      <button
        onPointerDown={(e) => (e.stopPropagation(), e.preventDefault(), remove(s))}
        className="absolute right-1 top-0.5 z-20 grid size-4 place-items-center rounded bg-black/60 text-white hover:bg-red-600"
        title="Remover"
      >
        <X className="size-3" />
      </button>
    );

  // Faixas de imagens: distribui em linhas para não sobrepor
  const imageLanes: string[][] = [];
  const laneOf: Record<string, number> = {};
  [...p.images].sort((a, b) => a.at - b.at).forEach((im) => {
    let l = imageLanes.findIndex((lane) => lane.every((id) => {
      const o = p.images.find((x) => x.id === id)!;
      return o.at + o.duration <= im.at || im.at + im.duration <= o.at;
    }));
    if (l < 0) l = imageLanes.push([]) - 1;
    imageLanes[l].push(im.id);
    laneOf[im.id] = l;
  });
  const imgRows = Math.max(1, imageLanes.length);

  const rows: { key: string; label: string; icon: React.ReactNode; h: number }[] = [
    { key: 'title', label: 'Título', icon: <Type />, h: TRACK_H },
    { key: 'video', label: 'Vídeo', icon: <Film />, h: TRACK_H + 8 },
    { key: 'images', label: 'Imagens', icon: <ImageIcon />, h: imgRows * 28 + 6 },
    { key: 'music', label: 'Fundo', icon: <Music />, h: TRACK_H - 4 },
    { key: 'sfx', label: 'Sons', icon: <Volume2 />, h: TRACK_H - 4 },
  ];

  return (
    <section className="flex max-h-[34vh] shrink-0 flex-col rounded-xl border bg-card">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-1.5 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">Linha do tempo</span>
        <span>arraste para mover · bordas aparam · clique na régua para ir ao ponto · espaço toca</span>
        <label className="ml-auto flex items-center gap-2">
          Zoom
          <input type="range" min={10} max={160} value={pps} onChange={(e) => setPps(Number(e.target.value))} className="w-32 accent-[#e07a3a]" />
        </label>
      </div>
      <div ref={scroller} className="relative min-h-0 overflow-auto">
        <div className="relative" style={{ width: width + 96 }}>
          {/* régua */}
          <div className="sticky top-0 z-30 flex h-6 cursor-pointer border-b bg-card" onPointerDown={seekFrom}>
            <div className="w-24 shrink-0 border-r bg-card" />
            <div className="relative flex-1">
              {Array.from({ length: Math.ceil(total + 2) }, (_, s) => (
                <span key={s} className="absolute top-0 h-full border-l border-white/10 pl-1 text-[10px] text-muted-foreground" style={{ left: s * pps }}>
                  {pps >= 25 || s % 5 === 0 ? `${s}s` : ''}
                </span>
              ))}
            </div>
          </div>
          {rows.map((r) => (
            <div key={r.key} className="flex border-b border-white/5" style={{ height: r.h }}>
              <div className="sticky left-0 z-20 flex w-24 shrink-0 items-center gap-1.5 border-r bg-card px-3 text-xs text-muted-foreground [&_svg]:size-3.5">
                {r.icon}
                {r.label}
              </div>
              <div
                className="relative flex-1"
                onDoubleClick={(e) => {
                  if (r.key !== 'title') return;
                  const x = (e.clientX - e.currentTarget.getBoundingClientRect().left) / pps;
                  const id = uid();
                  update((c) => ({ ...c, titleMode: 'spans', titleSpans: [...c.titleSpans, { id, at: clamp(x, 0, total), end: clamp(x + 3, 0, total) }] }));
                  setSel({ kind: 'span', id });
                }}
              >
                {r.key === 'video' &&
                  p.clips.map((c, i) => {
                    const len = clipLength(c);
                    return (
                      <div
                        key={c.id}
                        className={cn(block, 'cursor-grab bg-gradient-to-b from-[#5b2a6e] to-[#3a1a4a] px-2 py-1', isSel('clip', c.id) ? 'border-amber-400 ring-2 ring-amber-400' : 'border-white/20')}
                        style={{ left: offsets[i] * pps, width: Math.max(6, len * pps - 2) }}
                        onPointerDown={(e) =>
                          drag(
                            e,
                            { kind: 'clip', id: c.id },
                            (dt) => setDropAt(offsets[i] + dt + len / 2),
                            (dt) => {
                              setDropAt(null);
                              // Solta: vai para a posição cujo meio ficou mais perto
                              const mid = offsets[i] + dt + len / 2;
                              const others = p.clips.filter((x) => x.id !== c.id);
                              let acc = 0;
                              let j = 0;
                              for (; j < others.length; j++) {
                                if (mid < acc + clipLength(others[j]) / 2) break;
                                acc += clipLength(others[j]);
                              }
                              if (Math.abs(dt) * pps < 4) return;
                              update((cur) => {
                                const rest = cur.clips.filter((x) => x.id !== c.id);
                                rest.splice(j, 0, cur.clips.find((x) => x.id === c.id)!);
                                return { ...cur, clips: rest };
                              });
                            },
                          )
                        }
                      >
                        {handle('l', (e) => {
                          const s0 = c.start;
                          drag(e, { kind: 'clip', id: c.id }, (dt) => update((cur) => ({ ...cur, clips: cur.clips.map((x) => (x.id === c.id ? { ...x, start: clamp(s0 + dt, 0, x.end - 0.3) } : x)) })));
                        })}
                        {handle('r', (e) => {
                          const e0 = c.end;
                          drag(e, { kind: 'clip', id: c.id }, (dt) => update((cur) => ({ ...cur, clips: cur.clips.map((x) => (x.id === c.id ? { ...x, end: clamp(e0 + dt, x.start + 0.3, x.sourceDuration) } : x)) })));
                        })}
                        {del({ kind: 'clip', id: c.id })}
                        <div className="truncate font-medium">
                          {i + 1}. {c.file}
                        </div>
                        <div className="text-white/60">
                          {len.toFixed(1)}s · {c.start.toFixed(1)}–{c.end.toFixed(1)}
                        </div>
                      </div>
                    );
                  })}
                {r.key === 'video' && dropAt !== null && <span className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: dropAt * pps }} />}
                {r.key === 'title' &&
                  (p.titleMode === 'all' ? (
                    <div className={cn(block, 'border-white/20 bg-gradient-to-r from-[#e07a3a]/80 to-[#5b2a6e]/80 px-2 py-1.5')} style={{ left: 0, width: total * pps }}>
                      <span className="truncate">{p.title || '(sem título)'} · vídeo todo</span>
                    </div>
                  ) : (
                    p.titleSpans.map((s) => (
                      <div
                        key={s.id}
                        className={cn(block, 'cursor-grab bg-[#e07a3a]/85 px-2 py-1.5', isSel('span', s.id) ? 'border-amber-300 ring-2 ring-amber-300' : 'border-white/20')}
                        style={{ left: s.at * pps, width: Math.max(6, (s.end - s.at) * pps) }}
                        onPointerDown={(e) => {
                          const a0 = s.at;
                          const len = s.end - s.at;
                          drag(e, { kind: 'span', id: s.id }, (dt) => update((cur) => ({ ...cur, titleSpans: cur.titleSpans.map((x) => (x.id === s.id ? { ...x, at: clamp(a0 + dt, 0, total - len), end: clamp(a0 + dt, 0, total - len) + len } : x)) })));
                        }}
                      >
                        {handle('l', (e) => {
                          const a0 = s.at;
                          drag(e, { kind: 'span', id: s.id }, (dt) => update((cur) => ({ ...cur, titleSpans: cur.titleSpans.map((x) => (x.id === s.id ? { ...x, at: clamp(a0 + dt, 0, x.end - 0.2) } : x)) })));
                        })}
                        {handle('r', (e) => {
                          const e0 = s.end;
                          drag(e, { kind: 'span', id: s.id }, (dt) => update((cur) => ({ ...cur, titleSpans: cur.titleSpans.map((x) => (x.id === s.id ? { ...x, end: clamp(e0 + dt, x.at + 0.2, total) } : x)) })));
                        })}
                        {del({ kind: 'span', id: s.id })}
                        <span className="truncate">{p.title || 'Título'}</span>
                      </div>
                    ))
                  ))}
                {r.key === 'title' && p.titleMode === 'spans' && !p.titleSpans.length && <span className="absolute left-2 top-3 text-[11px] text-muted-foreground">duplo clique para marcar um trecho</span>}
                {r.key === 'images' &&
                  p.images.map((im) => (
                    <div
                      key={im.id}
                      className={cn(block, 'bottom-auto flex cursor-grab items-center gap-1 bg-sky-700/80 pr-2', isSel('image', im.id) ? 'border-amber-400 ring-2 ring-amber-400' : 'border-white/20')}
                      style={{ left: im.at * pps, width: Math.max(6, im.duration * pps), top: 3 + laneOf[im.id] * 28, height: 25 }}
                      onPointerDown={(e) => {
                        const a0 = im.at;
                        drag(e, { kind: 'image', id: im.id }, (dt) => update((cur) => ({ ...cur, images: cur.images.map((x) => (x.id === im.id ? { ...x, at: clamp(a0 + dt, 0, Math.max(0, total - 0.1)) } : x)) })));
                      }}
                    >
                      {handle('r', (e) => {
                        const d0 = im.duration;
                        drag(e, { kind: 'image', id: im.id }, (dt) => update((cur) => ({ ...cur, images: cur.images.map((x) => (x.id === im.id ? { ...x, duration: Math.max(0.2, d0 + dt) } : x)) })));
                      })}
                      {del({ kind: 'image', id: im.id })}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={fileUrl(im.file)} alt="" draggable={false} className="h-full w-7 shrink-0 bg-black/30 object-contain" />
                      <span className="truncate">{im.file.split(/[\\/]/).pop()}</span>
                    </div>
                  ))}
                {r.key === 'music' &&
                  (p.music ? (
                    <div className={cn(block, 'cursor-pointer bg-emerald-700/70 px-2 py-1', isSel('music') ? 'border-amber-400 ring-2 ring-amber-400' : 'border-white/20')} style={{ left: 0, width: total * pps }} onPointerDown={(e) => (e.stopPropagation(), setSel({ kind: 'music' }))}>
                      {del({ kind: 'music' })}
                      <span className="truncate">
                        ♪ {p.music.file.split(/[\\/]/).pop()} · {Math.round(p.music.volume * 100)}%
                      </span>
                    </div>
                  ) : (
                    <span className="absolute left-2 top-2.5 text-[11px] text-muted-foreground">sem fundo — escolha em “Imagens e sons”</span>
                  ))}
                {r.key === 'sfx' &&
                  p.sfx.map((s) => (
                    <div
                      key={s.id}
                      className={cn(block, 'cursor-grab bg-rose-700/80 px-1.5 py-1', isSel('sfx', s.id) ? 'border-amber-400 ring-2 ring-amber-400' : 'border-white/20')}
                      style={{ left: s.at * pps, width: Math.max(14, s.duration * pps) }}
                      onPointerDown={(e) => {
                        const a0 = s.at;
                        drag(e, { kind: 'sfx', id: s.id }, (dt) => update((cur) => ({ ...cur, sfx: cur.sfx.map((x) => (x.id === s.id ? { ...x, at: clamp(a0 + dt, 0, Math.max(0, total - 0.1)) } : x)) })));
                      }}
                    >
                      {handle('r', (e) => {
                        const d0 = s.duration;
                        drag(e, { kind: 'sfx', id: s.id }, (dt) => update((cur) => ({ ...cur, sfx: cur.sfx.map((x) => (x.id === s.id ? { ...x, duration: clamp(d0 + dt, 0.2, 60) } : x)) })));
                      })}
                      {del({ kind: 'sfx', id: s.id })}
                      <span className="truncate">
                        {s.file.split(/[\\/]/).pop()} · {Math.round(s.volume * 100)}%
                      </span>
                    </div>
                  ))}
                {/* fim do compilado */}
                <span className="pointer-events-none absolute inset-y-0 border-l border-dashed border-white/20" style={{ left: total * pps }} />
              </div>
            </div>
          ))}
          {/* cursor */}
          <span className="pointer-events-none absolute bottom-0 top-0 z-30 w-0.5 bg-amber-400" style={{ left: 96 + t * pps }}>
            <span className="absolute -left-1.5 top-0 size-3.5 rounded-full bg-amber-400" />
          </span>
        </div>
      </div>
    </section>
  );
}
