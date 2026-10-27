'use client';
import { Cpu } from 'lucide-react';
import type { JobAiUsage } from '@clipper/shared';
import { formatTokens, modelLabel } from '@/components/ai-usage';
import { api, usePolling } from '@/lib/client';

/** Header: tokens de IA gastos hoje e nos últimos 7 dias (todos os jobs); detalhe por modelo no tooltip. */
export function AiUsageBadge() {
  const { data } = usePolling(() => api<{ today: JobAiUsage; week: JobAiUsage }>('/api/ai-usage'), 60_000);
  if (!data) return null;
  const sum = (u: JobAiUsage) => u.total.inputTokens + u.total.outputTokens;
  const paid = data.week.entries.filter((e) => !e.free).reduce((a, e) => a + e.costUsd, 0);
  const title = [
    'Uso de IA nos últimos 7 dias, por modelo:',
    ...data.week.entries.map((e) => `• ${modelLabel(e.model)} (${e.provider}): ${formatTokens(e.inputTokens + e.outputTokens)} tokens em ${e.calls} chamada(s)${e.free ? '' : ` · ≈ US$ ${e.costUsd.toFixed(2)}`}`),
    ...(data.week.entries.length ? [] : ['• nenhuma chamada']),
    '',
    'Pela assinatura Claude o app não recebe o % do limite do plano; veja em claude.ai → Configurações → Uso.',
  ].join('\n');
  return (
    <span className="ml-auto hidden items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground md:flex" title={title}>
      <Cpu className="size-3.5" />
      IA hoje: {formatTokens(sum(data.today))} tokens · 7 dias: {formatTokens(sum(data.week))}
      {paid > 0 && ` · ≈ US$ ${paid.toFixed(2)}`}
    </span>
  );
}
