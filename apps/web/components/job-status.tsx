import { CheckCircle2, Clock, Loader2, Ban, XCircle } from 'lucide-react';
import { PIPELINE_STEPS, type JobStatus } from '@clipper/shared';
import { Badge } from '@/components/ui/badge';

const MAP: Record<JobStatus, { label: string; variant: 'secondary' | 'default' | 'success' | 'destructive' | 'warning'; icon: React.ReactNode }> = {
  pending: { label: 'Pendente', variant: 'secondary', icon: <Clock className="size-3" /> },
  processing: { label: 'Processando', variant: 'default', icon: <Loader2 className="size-3 animate-spin" /> },
  completed: { label: 'Concluído', variant: 'success', icon: <CheckCircle2 className="size-3" /> },
  failed: { label: 'Falhou', variant: 'destructive', icon: <XCircle className="size-3" /> },
  cancelled: { label: 'Cancelado', variant: 'warning', icon: <Ban className="size-3" /> },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const m = MAP[status];
  return (
    <Badge variant={m.variant}>
      {m.icon}
      {m.label}
    </Badge>
  );
}

export function stepLabel(step: string): string {
  return PIPELINE_STEPS.find((s) => s.key === step)?.label ?? step;
}
