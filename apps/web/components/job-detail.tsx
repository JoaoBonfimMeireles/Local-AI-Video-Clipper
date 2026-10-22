'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Ban, CheckCircle2, Circle, Download, FileJson, FileText, FolderOpen, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { formatTimestamp, PIPELINE_STEPS, type Clip, type Job, type JobLog } from '@clipper/shared';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { JobStatusBadge, stepLabel } from '@/components/job-status';
import { api, fileUrl } from '@/lib/client';
import { cn } from '@/lib/utils';

interface DetailResponse {
  job: Job;
  clips: Clip[];
  logs: JobLog[];
}

export function JobDetail({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastLog = useRef(0);
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
        if (r.logs.length) {
          lastLog.current = r.logs[r.logs.length - 1].id;
          setLogs((l) => [...l, ...r.logs].slice(-1000));
        }
        setError(null);
        const active = r.job.status === 'processing' || r.job.status === 'pending';
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
                      <Loader2 className="size-4 animate-spin text-primary" />
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

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Cortes {clips.length > 0 && <span className="text-muted-foreground">({clips.filter((c) => c.status === 'completed').length}/{clips.length})</span>}</h2>
        {!clips.length && <p className="text-sm text-muted-foreground">Os cortes aparecem aqui após a etapa de seleção.</p>}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {clips.map((c) => (
            <ClipCard key={c.id} clip={c} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ClipCard({ clip }: { clip: Clip }) {
  const thumb = clip.outputPath?.replace(/\.mp4$/, '.jpg');
  return (
    <Card className="overflow-hidden">
      <div className="grid aspect-video place-items-center bg-black/50">
        {clip.status === 'completed' && clip.outputPath ? (
          <video src={fileUrl(clip.outputPath)} poster={thumb ? fileUrl(thumb) : undefined} controls preload="none" className="h-full max-h-[420px] w-full object-contain" />
        ) : clip.status === 'failed' ? (
          <XCircle className="size-8 text-destructive" />
        ) : (
          <Loader2 className={cn('size-8 text-muted-foreground', clip.status === 'rendering' && 'animate-spin text-primary')} />
        )}
      </div>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-start gap-2">
          <span className="text-xs font-mono text-muted-foreground">#{String(clip.index + 1).padStart(3, '0')}</span>
          <p className="flex-1 text-sm font-medium leading-snug">{clip.title}</p>
          <Badge variant={clip.score >= 75 ? 'success' : clip.score >= 55 ? 'default' : 'secondary'}>{clip.score}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {formatTimestamp(clip.start)} → {formatTimestamp(clip.end)} · {(clip.end - clip.start).toFixed(0)}s
        </p>
        {clip.reason && <p className="line-clamp-3 text-xs text-muted-foreground">{clip.reason}</p>}
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
