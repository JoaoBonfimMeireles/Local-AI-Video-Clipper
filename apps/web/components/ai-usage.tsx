import type { AiUsageEntry, AiUsageTotals } from '@clipper/shared';
import { cn } from '@/lib/utils';

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
/** 12300 → "12,3 mil"; 1500000 → "1,5 mi". */
export const formatTokens = (n: number) => compact.format(n);

const usd = (n: number) => `US$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: n < 0.1 ? 4 : 2, maximumFractionDigits: n < 0.1 ? 4 : 2 })}`;

/** "claude-sonnet-5-5" → "Claude Sonnet 5.5"; ids de outros provedores ficam como estão. */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(model);
  if (!m) return model;
  return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

const PROVIDER_LABEL: Record<string, string> = {
  'claude-code': 'assinatura Claude',
  anthropic: 'API Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama (local)',
};

/** Custo em texto: cobrado (API paga), gratuito, ou só o equivalente na API (assinatura). */
function costText(u: AiUsageTotals, provider?: string): string {
  if (!u.free) return `≈ ${usd(u.costUsd)}`;
  if (provider === 'claude-code') return u.costUsd > 0 ? `sem cobrança por token (equivale a ~${usd(u.costUsd)} na API)` : 'sem cobrança por token';
  return provider === 'ollama' ? 'local, sem custo' : 'gratuito';
}

/** "12,3 mil tokens (entrada 10 mil / saída 2,3 mil)", ou "uso não informado" quando o provedor não devolveu contagem. */
export function tokensText(u: AiUsageTotals): string {
  if (u.unmeasuredCalls >= u.calls) return `${u.calls} chamada(s), uso não informado pelo provedor`;
  return `${formatTokens(u.inputTokens + u.outputTokens)} tokens (entrada ${formatTokens(u.inputTokens)} / saída ${formatTokens(u.outputTokens)})`;
}

function cacheHint(u: AiUsageTotals): string | undefined {
  const parts = [`${u.calls} chamada(s)`];
  if (u.cacheReadTokens > 0) parts.push(`${u.cacheReadTokens.toLocaleString('pt-BR')} tokens da entrada vieram do cache (custam bem menos)`);
  if (u.unmeasuredCalls > 0 && u.unmeasuredCalls < u.calls) parts.push(`${u.unmeasuredCalls} chamada(s) sem contagem informada`);
  return parts.join(' · ');
}

/** Uma linha por modelo usado numa etapa: "IA: 12,3 mil tokens (…) · Claude Sonnet 5.5 · custo". */
export function AiUsageLine({ entry, className, prefix = 'IA' }: { entry: AiUsageEntry; className?: string; prefix?: string }) {
  return (
    <p className={cn('text-xs text-muted-foreground', className)} title={cacheHint(entry)}>
      {prefix}: {tokensText(entry)} · {modelLabel(entry.model)}
      {PROVIDER_LABEL[entry.provider] ? ` (${PROVIDER_LABEL[entry.provider]})` : ''} · {costText(entry, entry.provider)}
    </p>
  );
}

/** Total do job (todas as etapas e modelos). */
export function AiUsageTotal({ total, entries }: { total: AiUsageTotals; entries: AiUsageEntry[] }) {
  const providers = new Set(entries.map((e) => e.provider));
  const only = providers.size === 1 ? [...providers][0] : undefined;
  return (
    <div className="space-y-0.5" title={cacheHint(total)}>
      <p>
        Uso de IA neste processo: {tokensText(total)} · {costText(total, only)}
      </p>
      {providers.has('claude-code') && (
        <p className="text-[11px] opacity-80">
          O plano Claude não informa ao app quanto % da sua sessão ou semana isso representa; o andamento do limite aparece em claude.ai → Configurações → Uso.
        </p>
      )}
    </div>
  );
}
