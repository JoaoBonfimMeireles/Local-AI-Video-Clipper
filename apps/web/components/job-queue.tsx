'use client';
import Link from 'next/link';
import { Ban, ChevronRight, ListVideo, RotateCcw, Trash2 } from 'lucide-react';
import type { Job } from '@clipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { JobStatusBadge, stepLabel } from '@/components/job-status';
import { api } from '@/lib/client';

export function JobQueue({ jobs, onChange }: { jobs: Job[] | null; onChange: () => void }) {
  const act = async (url: string, method = 'POST') => {
    await api(url, { method }).catch(() => undefined);
    onChange();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListVideo className="size-4 text-primary" /> Fila de tarefas
        </CardTitle>
        <CardDescription>Atualiza em tempo real. O worker processa um vídeo por vez.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {!jobs && <p className="text-sm text-muted-foreground">Carregando…</p>}
        {jobs?.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Nenhum job ainda. Envie um vídeo para começar.</p>}
        {jobs?.map((job) => {
          const active = job.status === 'processing' || job.status === 'pending';
          return (
            <div key={job.id} className="group rounded-lg border p-3 transition-colors hover:bg-accent/30">
              <div className="flex items-center gap-2">
                <Link href={`/jobs/${job.id}`} className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{job.videoName}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(job.createdAt).toLocaleString('pt-BR')} · {job.settings.format.replace('_', ' ')} · {job.settings.intensity}
                    {job.result?.clipsRendered !== undefined && ` · ${job.result.clipsRendered} corte(s)`}
                  </div>
                </Link>
                <JobStatusBadge status={job.status} />
                <div className="flex items-center">
                  {active && (
                    <Button variant="ghost" size="icon" title="Cancelar" onClick={() => act(`/api/jobs/${job.id}/cancel`)}>
                      <Ban />
                    </Button>
                  )}
                  {(job.status === 'failed' || job.status === 'cancelled') && (
                    <Button variant="ghost" size="icon" title="Tentar novamente" onClick={() => act(`/api/jobs/${job.id}/retry`)}>
                      <RotateCcw />
                    </Button>
                  )}
                  {job.status !== 'processing' && (
                    <Button variant="ghost" size="icon" title="Remover da lista" onClick={() => act(`/api/jobs/${job.id}`, 'DELETE')}>
                      <Trash2 />
                    </Button>
                  )}
                  <Link href={`/jobs/${job.id}`} className="p-1 text-muted-foreground hover:text-foreground">
                    <ChevronRight className="size-4" />
                  </Link>
                </div>
              </div>
              {job.status === 'processing' && (
                <div className="mt-2 space-y-1">
                  <Progress value={job.progress * 100} />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{stepLabel(job.step)}</span>
                    <span>{(job.progress * 100).toFixed(0)}%</span>
                  </div>
                </div>
              )}
              {job.status === 'failed' && job.error && <p className="mt-2 line-clamp-2 text-xs text-destructive">{job.error}</p>}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
