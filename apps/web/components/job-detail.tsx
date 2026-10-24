'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Ban, Check, CheckCircle2, Circle, CircleDot, Clapperboard, Copy, Download, PenLine, FileJson, FileText, FolderOpen, Loader2, RotateCcw, SlidersHorizontal, Star, XCircle } from 'lucide-react';
import { formatTimestamp, PIPELINE_STEPS, type Clip, type Job, type JobLog } from '@clipper/shared';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { JobStatusBadge, stepLabel } from '@/components/job-status';
import { ManualEditor } from '@/components/manual-editor';
import { AssetRequests } from '@/components/asset-requests';
import { api, fileUrl } from '@/lib/client';
import { cn } from '@/lib/utils';

/** Último ajuste pedido em um corte (job de ajuste separado, mostrado só no card do corte). */
export interface RevisionStatus {
  id: string;
  status: Job['status'];
  step: string;
  progress: number;
  comment: string;
  error: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface DetailResponse {
  job: Job;
  clips: Clip[];
  logs: JobLog[];
  revisions: Record<number, RevisionStatus>;
}

export const revisionActive = (r?: RevisionStatus) => !!r && (r.status === 'pending' || r.status === 'processing');

export function JobDetail({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [revisions, setRevisions] = useState<Record<number, RevisionStatus>>({});
  const [error, setError] = useState<string | null>(null);
  /** Cortes deste job que estão nos favoritos: índice do corte → id do favorito. */
  const [favorites, setFavorites] = useState<Record<number, { id: string; at: string }>>({});
  const lastLog = useRef(0);

  const loadFavorites = async () => {
    const r = await api<{ favorites: { id: string; jobId: string; clipIndex: number; favoritedAt: string }[] }>('/api/favorites').catch(() => null);
    if (!r) return;
    const map: Record<number, { id: string; at: string }> = {};
    // Lista vem do mais recente para o mais antigo: o primeiro de cada corte é o atual
    for (const f of r.favorites) if (f.jobId === id && !(f.clipIndex in map)) map[f.clipIndex] = { id: f.id, at: f.favoritedAt };
    setFavorites(map);
  };
  useEffect(() => {
    loadFavorites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const logBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await api<DetailResponse>(`/api/jobs/${id}?afterLog=${lastLog.current}`);
        if (!alive) return;
        setJob(r.job);
        setClips(r.clips);
        setRevisions(r.revisions ?? {});
        if (r.logs.length) {
          lastLog.current = r.logs[r.logs.length - 1].id;
          setLogs((l) => [...l, ...r.logs].slice(-1000));
        }
        setError(null);
        const active = r.job.status === 'processing' || r.job.status === 'pending' || Object.values(r.revisions ?? {}).some(revisionActive);
        timer = setTimeout(tick, active ? 1200 : 5000);
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
        timer = setTimeout(tick, 4000);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    logBox.current?.scrollTo({ top: logBox.current.scrollHeight });
  }, [logs.length]);

  const act = async (path: string) => {
    await api(`/api/jobs/${id}/${path}`, { method: 'POST' }).catch(() => undefined);
    if (path === 'retry') {
      setLogs([]);
      lastLog.current = 0;
    }
  };

  if (error && !job) return <p className="text-destructive">{error}</p>;
  if (!job) return <p className="text-muted-foreground">Carregando…</p>;

  const currentIdx = PIPELINE_STEPS.findIndex((s) => s.key === job.step);
  const active = job.status === 'processing' || job.status === 'pending';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          <ArrowLeft /> Painel
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold">{job.videoName}</h1>
        <JobStatusBadge status={job.status} />
        {active && (
          <Button variant="outline" size="sm" onClick={() => act('cancel')}>
            <Ban /> Cancelar
          </Button>
        )}
        {!active && (
          <Button variant="outline" size="sm" onClick={() => act('retry')}>
            <RotateCcw /> {job.status === 'completed' ? 'Reprocessar' : 'Tentar novamente'}
          </Button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Pipeline</CardTitle>
            <CardDescription>
              {job.settings.format.replace('_', ' ')} · intensidade {job.settings.intensity} · ~{job.settings.targetDuration}s ·{' '}
              {job.settings.maxClips === 'auto' ? 'qtd. automática' : `até ${job.settings.maxClips} cortes`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Progress value={job.progress * 100} indicatorClassName={job.status === 'failed' ? 'bg-destructive' : job.status === 'completed' ? 'bg-success' : undefined} />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{job.status === 'processing' ? stepLabel(job.step) : job.status === 'pending' ? 'Aguardando o worker…' : ''}</span>
                <span>{(job.progress * 100).toFixed(0)}%</span>
              </div>
            </div>
            <ol className="space-y-2">
              {PIPELINE_STEPS.map((s, i) => {
                const done = job.status === 'completed' || i < currentIdx;
                const running = job.status === 'processing' && i === currentIdx;
                const failedHere = job.status === 'failed' && i === currentIdx;
                return (
                  <li key={s.key} className={cn('flex items-center gap-2 text-sm', !done && !running && !failedHere && 'text-muted-foreground')}>
                    {failedHere ? (
                      <XCircle className="size-4 text-destructive" />
                    ) : running ? (
                      <CircleDot className="size-4 text-primary" />
                    ) : done ? (
                      <CheckCircle2 className="size-4 text-success" />
                    ) : (
                      <Circle className="size-4" />
                    )}
                    {i + 1}. {s.label}
                  </li>
                );
              })}
            </ol>
            {job.error && <p className="rounded-md bg-destructive/10 p-2 text-xs whitespace-pre-wrap text-destructive">{job.error}</p>}
            <div className="space-y-1 text-xs text-muted-foreground">
              {job.result?.provider && <p>IA: {job.result.provider}</p>}
              {job.result?.aiUsage && job.result.aiUsage.calls > 0 && (
                <p>
                  Uso: {job.result.aiUsage.calls} chamada(s), {(job.result.aiUsage.inputTokens + job.result.aiUsage.outputTokens).toLocaleString('pt-BR')} tokens —{' '}
                  {job.result.aiUsage.free ? 'gratuito' : `≈ US$ ${job.result.aiUsage.costUsd.toFixed(4)}`}
                </p>
              )}
              {job.result?.language && <p>Idioma detectado: {job.result.language}</p>}
              {job.result?.outputDir && (
                <p className="flex items-start gap-1 break-all">
                  <FolderOpen className="mt-0.5 size-3 shrink-0" />
                  {job.result.outputDir}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Logs</CardTitle>
          </CardHeader>
          <CardContent>
            <div ref={logBox} className="h-80 overflow-auto rounded-lg border bg-black/40 p-3 font-mono text-xs leading-relaxed">
              {logs.map((l) => (
                <div key={l.id} className={cn(l.level === 'error' && 'text-destructive', l.level === 'warn' && 'text-warning')}>
                  <span className="text-muted-foreground">{new Date(l.ts).toLocaleTimeString('pt-BR')}</span> {l.message}
                </div>
              ))}
              {!logs.length && <span className="text-muted-foreground">Sem logs ainda.</span>}
            </div>
          </CardContent>
        </Card>
      </div>

      {job.result?.outputDir && job.status === 'completed' && <VideoInfo outputDir={job.result.outputDir} />}
      {job.settings.reference && <AssetRequests jobId={job.id} canRerender={job.status === 'completed' || job.status === 'failed'} />}

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Cortes {clips.length > 0 && <span className="text-muted-foreground">({clips.filter((c) => c.status === 'completed').length}/{clips.length})</span>}</h2>
        {!clips.length && <p className="text-sm text-muted-foreground">Os cortes aparecem aqui após a etapa de seleção.</p>}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {clips.map((c) => (
            <ClipCard
              key={c.id}
              clip={c}
              revision={revisions[c.index]}
              onRevise={(rev) => setRevisions((all) => ({ ...all, [c.index]: rev }))}
              // Depois de reprocessar, o corte #N é outro vídeo: a estrela só vale para favoritos desta rodada
              favoriteId={favorites[c.index] && (!job.startedAt || favorites[c.index].at >= job.startedAt) ? favorites[c.index].id : undefined}
              onFavoriteChange={loadFavorites}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface Knowledge {
  summary: string;
  format: string;
  speakers: { id: string; description: string; position: string }[];
  topics: string[];
}

/** Resumo da IA sobre o vídeo (do cache de conhecimento) + texto em português do que é falado. */
function VideoInfo({ outputDir }: { outputDir: string }) {
  const [knowledge, setKnowledge] = useState<Knowledge | null>(null);
  const [ptText, setPtText] = useState<string | null>(null);
  useEffect(() => {
    const sep = outputDir.includes('\\') ? '\\' : '/';
    fetch(fileUrl(`${outputDir}${sep}video_knowledge.json`))
      .then((r) => (r.ok ? r.json() : null))
      .then(setKnowledge)
      .catch(() => undefined);
    fetch(fileUrl(`${outputDir}${sep}transcricao_pt.txt`))
      .then((r) => (r.ok ? r.text() : null))
      .then(setPtText)
      .catch(() => undefined);
  }, [outputDir]);
  if (!knowledge && !ptText) return null;
  const sep = outputDir.includes('\\') ? '\\' : '/';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sobre o vídeo</CardTitle>
        {knowledge && <CardDescription>{knowledge.format}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">
        {knowledge && (
          <>
            <p className="text-sm">{knowledge.summary}</p>
            {knowledge.speakers.length > 0 && (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {knowledge.speakers.map((p) => (
                  <li key={p.id}>
                    <span className="font-medium text-foreground">{p.id}</span>: {p.description}
                    {p.position ? ` — ${p.position}` : ''}
                  </li>
                ))}
              </ul>
            )}
            {knowledge.topics.length > 0 && <p className="text-xs text-primary">{knowledge.topics.join(' · ')}</p>}
          </>
        )}
        {ptText && (
          <details className="rounded-md border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Texto em português do que é falado</summary>
            <pre className="max-h-96 overflow-auto border-t px-3 py-2 font-sans text-xs leading-relaxed whitespace-pre-wrap">{ptText}</pre>
            <div className="border-t px-3 py-2">
              <a className={buttonVariants({ size: 'sm', variant: 'outline' })} href={fileUrl(`${outputDir}${sep}transcricao_pt.txt`, true)}>
                <Download /> Baixar .txt
              </a>
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

/** Legenda sugerida para o post + hashtags, com botão para copiar tudo. */
export function PostText({ clip }: { clip: Pick<Clip, 'title' | 'description' | 'hashtags'> }) {
  const [copied, setCopied] = useState(false);
  const text = [clip.title, clip.description, clip.hashtags.join(' ')].filter(Boolean).join('\n\n');
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-2">
      {clip.description && <p className="text-xs whitespace-pre-wrap">{clip.description}</p>}
      {clip.hashtags.length > 0 && <p className="text-xs text-primary">{clip.hashtags.join(' ')}</p>}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check /> : <Copy />} {copied ? 'Copiado' : 'Copiar texto do post'}
      </Button>
    </div>
  );
}

/** "Ai-cat-laughing-Meme-Green-Screen.mp4" → "Ai cat laughing" (versão leve para o navegador). */
function prettyName(file: string): string {
  let name = file.replace(/\.[a-z0-9]{2,4}$/i, '');
  try {
    if (/%[0-9a-f]{2}/i.test(name)) name = decodeURIComponent(name);
  } catch {
    /* nome com % truncado */
  }
  return name
    .split(/[\s\-_]+/)
    .filter((w) => w && !/^(meme|green|screen|greenscreen|template|small)$/i.test(w))
    .join(' ');
}

interface ClipMeta {
  edit?: {
    overlays?: { file: string; at: number; audioMode?: string; reason?: string }[];
    sfx?: { file: string; at: number; reason?: string }[];
  };
  revision?: { version: number; comment: string; changes?: string | null };
}

const AUDIO_MODE: Record<string, string> = { meme: 'só o som do meme', video: 'meme mudo', both: 'meme + vídeo' };

/** Memes e sons que entraram no corte, com o momento e o motivo. */
export function ClipAssets({ metadataPath }: { metadataPath: string }) {
  const [meta, setMeta] = useState<ClipMeta | null>(null);
  useEffect(() => {
    fetch(fileUrl(metadataPath))
      .then((r) => (r.ok ? r.json() : null))
      .then(setMeta)
      .catch(() => undefined);
  }, [metadataPath]);
  if (!meta) return null;
  const memes = meta.edit?.overlays ?? [];
  const sounds = meta.edit?.sfx ?? [];
  return (
    <details className="rounded-md border px-2 py-1.5 text-xs">
      <summary className="cursor-pointer">
        {memes.length} meme(s) · {sounds.length} som(ns)
        {meta.revision ? <span className="ml-2 text-primary">versão {meta.revision.version}</span> : null}
      </summary>
      <ul className="mt-1.5 space-y-1">
        {memes.map((m, i) => (
          <li key={`m${i}`} title={m.reason}>
            🎬 <span className="font-medium">{prettyName(m.file)}</span> <span className="text-muted-foreground">em {m.at.toFixed(1)}s{m.audioMode ? ` · ${AUDIO_MODE[m.audioMode] ?? m.audioMode}` : ''}</span>
            <div className="truncate pl-5 font-mono text-[10px] text-muted-foreground">{m.file}</div>
          </li>
        ))}
        {sounds.map((x, i) => (
          <li key={`s${i}`} title={x.reason}>
            🔊 <span className="font-medium">{prettyName(x.file)}</span> <span className="text-muted-foreground">em {x.at.toFixed(1)}s</span>
            <div className="truncate pl-5 font-mono text-[10px] text-muted-foreground">{x.file}</div>
          </li>
        ))}
        {!memes.length && !sounds.length && <li className="text-muted-foreground">nenhum</li>}
      </ul>
      {meta.revision && <p className="mt-1.5 text-muted-foreground">Último ajuste: “{meta.revision.comment}”{meta.revision.changes ? ` → ${meta.revision.changes}` : ''}</p>}
    </details>
  );
}

const SUB_LANGS: { code: string; label: string }[] = [
  { code: 'pt', label: 'Português' },
  { code: 'en', label: 'Inglês' },
  { code: 'es', label: 'Espanhol' },
  { code: 'zh', label: 'Chinês' },
];

/** Vídeo com legenda em mandarim + legendas (SRT e SBV) nos 4 idiomas, prontas para subir no YouTube. */
export function LanguageDownloads({ metadataPath }: { metadataPath: string }) {
  const [files, setFiles] = useState<{ videoZh?: string | null; subtitles?: Record<string, { srt: string; sbv: string }> } | null>(null);
  useEffect(() => {
    fetch(fileUrl(metadataPath))
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => setFiles(m?.files ?? null))
      .catch(() => undefined);
  }, [metadataPath]);
  if (!files) return null;
  const dir = metadataPath.replace(/[^\\/]+$/, '');
  const subs = SUB_LANGS.filter((l) => files.subtitles?.[l.code]);
  if (!files.videoZh && !subs.length) return null;
  return (
    <div className="space-y-1.5 rounded-md border p-2 text-xs">
      {files.videoZh && (
        <div className="flex items-center gap-2">
          <span className="flex-1 font-medium">Vídeo com legenda em mandarim</span>
          <a className={buttonVariants({ size: 'sm', variant: 'outline' })} href={fileUrl(dir + files.videoZh)} target="_blank" rel="noreferrer">
            Ver
          </a>
          <a className={buttonVariants({ size: 'sm' })} href={fileUrl(dir + files.videoZh, true)}>
            <Download /> MP4 中文
          </a>
        </div>
      )}
      {subs.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium">Legendas (texto com os tempos, para subir no YouTube)</p>
          {subs.map((l) => (
            <div key={l.code} className="flex items-center gap-2">
              <span className="w-20 text-muted-foreground">{l.label}</span>
              <a className="text-primary underline-offset-2 hover:underline" href={fileUrl(dir + files.subtitles![l.code].srt, true)}>
                SRT
              </a>
              <a className="text-primary underline-offset-2 hover:underline" href={fileUrl(dir + files.subtitles![l.code].sbv, true)}>
                SBV
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Pedido de ajuste em um corte pronto: refaz só este corte (barato), sem reprocessar o vídeo. */
export function ReviseBox({ endpoint, onQueued }: { endpoint: string; onQueued: (rev: RevisionStatus) => void }) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  async function send() {
    setSending(true);
    setState(null);
    try {
      const r = await api<{ job: Job }>(endpoint, { method: 'POST', body: JSON.stringify({ comment }) });
      onQueued({ id: r.job.id, status: 'pending', step: r.job.step, progress: 0, comment, error: null, finishedAt: null, createdAt: r.job.createdAt });
      setComment('');
      setOpen(false);
    } catch (e) {
      setState({ ok: false, text: (e as Error).message });
    } finally {
      setSending(false);
    }
  }
  if (!open)
    return (
      <Button variant="outline" size="sm" className="w-full" onClick={() => setOpen(true)}>
        <PenLine /> Pedir ajuste neste corte
      </Button>
    );
  return (
    <div className="space-y-1.5 rounded-md border p-2">
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Ex.: tira o meme do gato e coloca um de susto aos 12s; começa 5s antes; som de risada mais baixo; título mais curto"
        className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex gap-1.5">
        <Button size="sm" onClick={send} disabled={sending || comment.trim().length < 3}>
          {sending ? 'Enviando…' : 'Refazer este corte'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
      {state && <p className={cn('text-xs', state.ok ? 'text-success' : 'text-destructive')}>{state.text}</p>}
    </div>
  );
}

/** Andamento do ajuste no próprio card: carregando, atualizado ou falhou. */
export function RevisionBanner({ rev }: { rev: RevisionStatus }) {
  if (revisionActive(rev))
    return (
      <div className="space-y-1 rounded-md border border-primary/40 bg-primary/10 p-2 text-xs">
        <p className="flex items-center gap-1.5 font-medium text-primary">
          <Loader2 className="size-3.5 animate-spin" /> {rev.status === 'pending' ? 'Ajuste na fila…' : `Ajustando… ${(rev.progress * 100).toFixed(0)}%`}
        </p>
        <Progress value={rev.progress * 100} />
        <p className="line-clamp-2 text-muted-foreground">“{rev.comment}”</p>
      </div>
    );
  if (rev.status === 'failed')
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
        <p className="font-medium">O ajuste falhou — o vídeo anterior foi mantido.</p>
        {rev.error && <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap">{rev.error}</p>}
      </div>
    );
  // Concluído há pouco: destaca que o vídeo acima já é a versão nova
  const recent = rev.status === 'completed' && rev.finishedAt && Date.now() - new Date(rev.finishedAt).getTime() < 30 * 60 * 1000;
  if (!recent) return null;
  return (
    <p className="flex items-center gap-1.5 rounded-md border border-success/40 bg-success/10 p-2 text-xs font-medium text-success">
      <CheckCircle2 className="size-3.5" /> Vídeo atualizado com o ajuste ({new Date(rev.finishedAt!).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })})
    </p>
  );
}

/** Estrela do corte: favorita (copia para a aba Favoritos) ou remove dos favoritos. */
function FavoriteButton({ clip, favoriteId, onChange }: { clip: Clip; favoriteId?: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try {
      if (favoriteId) {
        if (!confirm('Remover dos favoritos? A cópia guardada (e os ajustes feitos nela) será apagada.')) return;
        await api(`/api/favorites/${favoriteId}`, { method: 'DELETE' });
      } else {
        await api('/api/favorites', { method: 'POST', body: JSON.stringify({ jobId: clip.jobId, clipIndex: clip.index }) });
      }
      onChange();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={favoriteId ? 'Favoritado — clique para remover' : 'Favoritar (guarda uma cópia na aba Favoritos)'}
      className={cn('rounded p-0.5 transition-colors hover:bg-accent disabled:opacity-50', favoriteId ? 'text-yellow-400' : 'text-muted-foreground')}
    >
      <Star className={cn('size-4', favoriteId && 'fill-current')} />
    </button>
  );
}

function ClipCard({
  clip,
  revision,
  onRevise,
  favoriteId,
  onFavoriteChange,
}: {
  clip: Clip;
  revision?: RevisionStatus;
  onRevise: (rev: RevisionStatus) => void;
  favoriteId?: string;
  onFavoriteChange: () => void;
}) {
  const thumb = clip.outputPath?.replace(/\.mp4$/, '.jpg');
  const revising = revisionActive(revision);
  const [editing, setEditing] = useState(false);
  return (
    <Card className={cn('overflow-hidden', revising && 'ring-2 ring-primary/50')}>
      {editing && (
        <ManualEditor
          clip={clip}
          onClose={() => setEditing(false)}
          onQueued={(id, createdAt) => onRevise({ id, status: 'pending', step: 'plan', progress: 0, comment: 'Edição manual', error: null, finishedAt: null, createdAt })}
        />
      )}
      <div className="relative grid aspect-video place-items-center bg-black/50">
        {revising && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-black/60 text-sm text-white">
            <span className="flex items-center gap-2">
              <Loader2 className="size-5 animate-spin" /> {revision!.status === 'pending' ? 'Na fila…' : `Ajustando ${(revision!.progress * 100).toFixed(0)}%`}
            </span>
          </div>
        )}
        {clip.status === 'completed' && clip.outputPath ? (
          <video key={clip.outputPath} src={fileUrl(clip.outputPath)} poster={thumb ? fileUrl(thumb) : undefined} controls preload="none" className="h-full max-h-[420px] w-full object-contain" />
        ) : clip.status === 'failed' ? (
          <XCircle className="size-8 text-destructive" />
        ) : (
          <Clapperboard className={cn('size-8 text-muted-foreground', clip.status === 'rendering' && 'text-primary')} />
        )}
      </div>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-start gap-2">
          <span className="text-xs font-mono text-muted-foreground">#{String(clip.index + 1).padStart(3, '0')}</span>
          <p className="flex-1 text-sm font-medium leading-snug">{clip.title}</p>
          {clip.status === 'completed' && <FavoriteButton clip={clip} favoriteId={favoriteId} onChange={onFavoriteChange} />}
          <Badge variant={clip.score >= 75 ? 'success' : clip.score >= 55 ? 'default' : 'secondary'}>{clip.score}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {formatTimestamp(clip.start)} → {formatTimestamp(clip.end)} · {(clip.end - clip.start).toFixed(0)}s
        </p>
        {clip.reason && <p className="line-clamp-3 text-xs text-muted-foreground">{clip.reason}</p>}
        {(clip.description || clip.hashtags.length > 0) && <PostText clip={clip} />}
        {clip.status === 'completed' && clip.metadataPath && <ClipAssets key={clip.metadataPath} metadataPath={clip.metadataPath} />}
        {clip.status === 'completed' && clip.metadataPath && <LanguageDownloads key={`l${clip.metadataPath}`} metadataPath={clip.metadataPath} />}
        {revision && <RevisionBanner rev={revision} />}
        {clip.status === 'completed' && !revising && clip.metadataPath && (
          <Button variant="outline" size="sm" className="w-full" onClick={() => setEditing(true)}>
            <SlidersHorizontal /> Editar manualmente
          </Button>
        )}
        {clip.status === 'completed' && !revising && <ReviseBox endpoint={`/api/jobs/${clip.jobId}/clips/${clip.index}/revise`} onQueued={onRevise} />}
        {clip.error && <p className="line-clamp-4 text-xs whitespace-pre-wrap text-destructive">{clip.error}</p>}
        {clip.status === 'completed' && clip.outputPath && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            <a className={buttonVariants({ size: 'sm' })} href={fileUrl(clip.outputPath, true)}>
              <Download /> MP4
            </a>
            {clip.srtPath && (
              <a className={buttonVariants({ size: 'sm', variant: 'outline' })} href={fileUrl(clip.srtPath, true)}>
                <FileText /> SRT
              </a>
            )}
            {clip.metadataPath && (
              <a className={buttonVariants({ size: 'sm', variant: 'outline' })} href={fileUrl(clip.metadataPath)} target="_blank" rel="noreferrer">
                <FileJson /> JSON
              </a>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
