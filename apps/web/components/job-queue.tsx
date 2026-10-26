'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Ban, ListVideo, RotateCcw, Trash2 } from 'lucide-react';
import type { Job } from '@clipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { JobStatusBadge, stepLabel } from '@/components/job-status';
import { api } from '@/lib/client';
import { cn } from '@/lib/utils';

/** Tipos de tarefa da fila, na ordem em que as seções aparecem. */
const KINDS = [
  { key: 'youtube', label: 'Cortes de YouTube / podcast', desc: 'Vídeo longo → cortes' },
  { key: 'twitch', label: 'Cortes de live da Twitch', desc: 'Live ou trechos de VOD → cortes' },
  { key: 'reference', label: 'A partir de corte viral', desc: 'Corte de referência + original → versões próprias' },
  { key: 'vod', label: 'Análise de VOD da Twitch', desc: 'Acha os melhores momentos pela URL (sem cortar)' },
  { key: 'revision', label: 'Ajustes de cortes', desc: 'Refaz um corte pronto (comentário ou edição manual)' },
  { key: 'curiosity', label: 'Curiosidades', desc: 'Ideias e vídeos do canal de curiosidades' },
  { key: 'meme', label: 'Canal de memes', desc: 'Transcrição e compilados de memes' },
  { key: 'clean', label: 'Limpar vídeo', desc: 'Tira trechos, música, legenda ou logo' },
  { key: 'style', label: 'Guia de estilo', desc: 'Análise dos clipes de referência' },
] as const;
type Kind = (typeof KINDS)[number]['key'];

export function jobKind(job: Job): Kind {
  const s = job.settings;
  if (s.revision) return 'revision';
  if (s.analyzeReferences) return 'style';
  if (s.vodAnalysis) return 'vod';
  if (s.curiosity) return 'curiosity';
  if (s.meme) return 'meme';
  if (s.clean) return 'clean';
  if (s.reference) return 'reference';
  if (s.vodSource || s.mode === 'twitch') return 'twitch';
  return 'youtube';
}

/** Linha de detalhes do card: o que importa para cada tipo de tarefa. */
function details(job: Job, kind: Kind): string {
  const s = job.settings;
  const parts = [new Date(job.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })];
  if (kind === 'revision' && s.revision) parts.push(`corte ${s.revision.clipIndex + 1}${s.revision.manual ? ' · edição manual' : ''}`);
  else if (kind === 'meme' && s.meme) parts.push(s.meme.action === 'render' ? 'renderizar compilado' : 'transcrever');
  else if (kind === 'curiosity' && s.curiosity) parts.push(s.curiosity.analyze ? 'gerar ideias' : `${s.curiosity.ideas?.length ?? 0} vídeo(s)`);
  else if (kind === 'reference' && s.reference) parts.push(`${s.reference.variations} versões + ${s.reference.otherParts} outras`);
  else if (kind === 'youtube' || kind === 'twitch') parts.push(s.format.replace('_', ' '));
  if (job.result?.clipsRendered !== undefined) parts.push(`${job.result.clipsRendered} corte(s)`);
  return parts.join(' · ');
}

export function JobQueue({ jobs, onChange }: { jobs: Job[] | null; onChange: () => void }) {
  const [filter, setFilter] = useState<Kind | 'all'>('all');
  const act = async (url: string, method = 'POST') => {
    await api(url, { method }).catch(() => undefined);
    onChange();
  };
  const remove = (job: Job) => {
    if (!window.confirm(`Excluir "${job.videoName}"?\n\nApaga os cortes gerados, os arquivos temporários e o cache deste job para liberar espaço. Não dá para desfazer.`)) return;
    act(`/api/jobs/${job.id}`, 'DELETE');
  };

  const groups = KINDS.map((k) => ({ ...k, jobs: (jobs ?? []).filter((j) => jobKind(j) === k.key) })).filter((g) => g.jobs.length);
  const shown = filter === 'all' ? groups : groups.filter((g) => g.key === filter);
  const running = (jobs ?? []).filter((j) => j.status === 'processing' || j.status === 'pending').length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListVideo className="size-4 text-primary" /> Fila de tarefas
        </CardTitle>
        <CardDescription>
          Separada por tipo; role cada seção para o lado. O worker processa uma tarefa por vez{running ? ` — ${running} na fila agora` : ''}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!jobs && <p className="text-sm text-muted-foreground">Carregando…</p>}
        {jobs?.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Nenhuma tarefa ainda. Envie um vídeo para começar.</p>}
        {groups.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {[{ key: 'all' as const, label: 'Todas', count: jobs?.length ?? 0 }, ...groups.map((g) => ({ key: g.key, label: g.label, count: g.jobs.length }))].map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setFilter(t.key)}
                className={cn('shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors', filter === t.key ? 'border-primary bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-accent/40')}
              >
                {t.label} <span className="opacity-70">{t.count}</span>
              </button>
            ))}
          </div>
        )}
        {shown.map((g) => {
          const active = g.jobs.filter((j) => j.status === 'processing' || j.status === 'pending').length;
          return (
            <section key={g.key} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  {g.label} <span className="font-normal text-muted-foreground">({g.jobs.length})</span>
                </h3>
                <span className="truncate text-xs text-muted-foreground">{active ? `${active} rodando/na fila` : g.desc}</span>
              </div>
              <div className="flex snap-x gap-2 overflow-x-auto pb-2">
                {g.jobs.map((job) => (
                  <JobCard key={job.id} job={job} kind={g.key} act={act} remove={remove} />
                ))}
              </div>
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}

function JobCard({ job, kind, act, remove }: { job: Job; kind: Kind; act: (url: string, method?: string) => void; remove: (job: Job) => void }) {
  const active = job.status === 'processing' || job.status === 'pending';
  return (
    <div className="flex w-60 shrink-0 snap-start flex-col rounded-lg border p-2.5 transition-colors hover:bg-accent/30">
      <Link href={`/jobs/${job.id}`} className="min-w-0 flex-1">
        <div className="line-clamp-2 text-sm font-medium" title={job.videoName}>
          {job.videoName}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{details(job, kind)}</div>
      </Link>
      {job.status === 'processing' && (
        <div className="mt-2 space-y-1">
          <Progress value={job.progress * 100} />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span className="truncate">{stepLabel(job.step)}</span>
            <span>{(job.progress * 100).toFixed(0)}%</span>
          </div>
        </div>
      )}
      {job.status === 'failed' && job.error && <p className="mt-1.5 line-clamp-2 text-xs text-destructive">{job.error}</p>}
      <div className="mt-2 flex items-center gap-1">
        <JobStatusBadge status={job.status} />
        <div className="ml-auto flex items-center">
          {active && (
            <Button variant="ghost" size="icon" className="size-7" title="Cancelar" onClick={() => act(`/api/jobs/${job.id}/cancel`)}>
              <Ban />
            </Button>
          )}
          {(job.status === 'failed' || job.status === 'cancelled') && (
            <Button variant="ghost" size="icon" className="size-7" title="Tentar novamente" onClick={() => act(`/api/jobs/${job.id}/retry`)}>
              <RotateCcw />
            </Button>
          )}
          {job.status !== 'processing' && (
            <Button variant="ghost" size="icon" className="size-7" title="Excluir (apaga arquivos e cache)" onClick={() => remove(job)}>
              <Trash2 />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
