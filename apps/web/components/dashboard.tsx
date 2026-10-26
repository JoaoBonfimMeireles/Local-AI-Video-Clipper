'use client';
import type { Job } from '@clipper/shared';
import { JobQueue } from '@/components/job-queue';
import { LibraryPanel } from '@/components/library-panel';
import { NewJobForm } from '@/components/new-job-form';
import { api, usePolling } from '@/lib/client';

export function Dashboard() {
  // Rápido enquanto há tarefa rodando ou na fila; devagar quando está tudo parado
  const { data, refresh } = usePolling(
    () => api<{ jobs: Job[] }>('/api/jobs'),
    (d) => (d?.jobs.some((j) => j.status === 'processing' || j.status === 'pending') ? 1500 : 6000),
  );
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <div className="lg:col-span-3">
        <NewJobForm onCreated={refresh} />
      </div>
      <div className="space-y-6 lg:col-span-2">
        <JobQueue jobs={data?.jobs ?? null} onChange={refresh} />
        <LibraryPanel />
      </div>
    </div>
  );
}
