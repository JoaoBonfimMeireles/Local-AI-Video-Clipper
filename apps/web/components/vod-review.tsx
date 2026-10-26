'use client';
// Revisão dos melhores momentos de um VOD da Twitch ANTES de baixar qualquer vídeo: calor da live inteira,
// lista dos picos e o player da própria Twitch pulando para cada momento, para conferir se faz sentido.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckSquare, Download, ExternalLink, Loader2, Play, Square } from 'lucide-react';
import { formatTimestamp } from '@clipper/shared';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/client';
import { cn } from '@/lib/utils';

interface Moment {
  rank: number;
  start: number;
  end: number;
  peak: number;
  score: number;
  type: string;
  typeLabel: string;
  emotes: string[];
  chatPerMin: number;
  comments?: number;
  ranks?: Partial<Record<Mode, number>>;
}

type Mode = 'combined' | 'peaks' | 'comments';

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'combined', label: 'Os dois', hint: 'Picos e comentários juntos; um pico muito alto entra mesmo sem comentário.' },
  { id: 'peaks', label: 'Só picos', hint: 'Chat acelerado, emotes de reação e streamer mais alto que o normal.' },
  { id: 'comments', label: 'Só comentários', hint: 'O que o chat escreve: “melhor parte”, “muito engraçado”, kkkk longo, “clipa isso”…' },
];

/** Posição no filtro (peaks.json antigo, sem filtros, conta tudo como combinado). */
const rankIn = (m: Moment, mode: Mode) => (m.ranks ? m.ranks[mode] : mode === 'combined' ? m.rank : undefined);

interface Peaks {
  meta: { id: string; url: string; title: string; channel: string; duration: number };
  binSeconds: number;
  moments: Moment[];
  series: { t: number; s: number; c: number; r: number; m?: number; a: number }[];
}

const TYPE_COLOR: Record<string, string> = { funny: '#facc15', hype: '#f97316', scary: '#a78bfa', sad: '#60a5fa', chat: '#34d399', comment: '#22d3ee', audio: '#f472b6' };

const twitchTime = (t: number) => `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m${Math.floor(t % 60)}s`;

export function VodReview({ id }: { id: string }) {
  const [data, setData] = useState<Peaks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Moment | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('combined');
  const router = useRouter();

  useEffect(() => {
    fetch(`/api/vods/${id}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json()).error))))
      .then((d: Peaks) => {
        setData(d);
        const combined = d.moments.filter((m) => rankIn(m, 'combined'));
        setCurrent(combined[0] ?? d.moments[0] ?? null);
        setPicked(new Set(combined.map((m) => m.rank)));
      })
      .catch((e) => setError((e as Error).message));
  }, [id]);

  // Player oficial da Twitch: "parent" precisa ser o endereço desta página
  const playerUrl = useMemo(() => {
    if (!data || !current || typeof window === 'undefined') return null;
    return `https://player.twitch.tv/?video=v${data.meta.id}&parent=${window.location.hostname}&time=${twitchTime(current.start)}&autoplay=true`;
  }, [data, current]);

  const shown = useMemo(
    () => (data ? data.moments.filter((m) => rankIn(m, mode)).sort((a, b) => rankIn(a, mode)! - rankIn(b, mode)!) : []),
    [data, mode],
  );

  if (error) return <p className="text-destructive">{error}</p>;
  if (!data) return <p className="text-muted-foreground">Carregando…</p>;

  const toggle = (rank: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(rank)) n.delete(rank);
      else n.add(rank);
      return n;
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          <ArrowLeft /> Painel
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold">
          {data.meta.channel} — {data.meta.title}
        </h1>
        <a href={data.meta.url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <ExternalLink /> Abrir na Twitch
        </a>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Calor da live</CardTitle>
          <CardDescription>
            {formatTimestamp(data.meta.duration)} analisados pelo chat (picos em relação ao normal da própria live), pelos emotes de reação e pelo áudio. Clique num número para assistir.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {MODES.map((m) => (
              <Button key={m.id} size="sm" variant={mode === m.id ? 'default' : 'outline'} onClick={() => setMode(m.id)} title={m.hint}>
                {m.label} <span className="opacity-60">({data.moments.filter((x) => rankIn(x, m.id)).length})</span>
              </Button>
            ))}
            <span className="text-xs text-muted-foreground">{MODES.find((m) => m.id === mode)!.hint}</span>
          </div>
          <HeatChart data={data} mode={mode} moments={shown} current={current} onPick={setCurrent} picked={picked} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Card className="overflow-hidden">
          <div className="aspect-video bg-black">
            {playerUrl ? <iframe key={playerUrl} src={playerUrl} allowFullScreen className="h-full w-full" title="Player da Twitch" /> : null}
          </div>
          {current && (
            <CardContent className="space-y-1 pt-4 text-sm">
              <p className="font-medium">
                #{current.rank} · {formatTimestamp(current.start)} → {formatTimestamp(current.end)} <span className="text-muted-foreground">(pico do chat em {formatTimestamp(current.peak)})</span>
              </p>
              <p className="text-xs text-muted-foreground">
                O momento começa ~20 s antes do pico do chat: o público reage alguns segundos DEPOIS do que acontece.
              </p>
              <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={`${data.meta.url}?t=${twitchTime(current.start)}`} target="_blank" rel="noreferrer">
                <ExternalLink className="size-3" /> Abrir na Twitch neste momento (se o player não carregar aqui)
              </a>
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              Momentos · {MODES.find((m) => m.id === mode)!.label} <span className="text-muted-foreground">({picked.size} marcados no total)</span>
            </CardTitle>
            <CardDescription>Assista e marque/desmarque; trocar o filtro mantém as marcações. Só os marcados serão baixados (em vídeo, com margem) e viram cortes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {shown.map((m, i) => (
              <div
                key={m.rank}
                className={cn('flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm', current?.rank === m.rank && 'border-primary bg-primary/10', !picked.has(m.rank) && 'opacity-50')}
              >
                <button onClick={() => toggle(m.rank)} title={picked.has(m.rank) ? 'Desmarcar' : 'Marcar'} className="text-primary">
                  {picked.has(m.rank) ? <CheckSquare className="size-4" /> : <Square className="size-4" />}
                </button>
                <span className="w-6 font-mono text-xs text-muted-foreground">#{i + 1}</span>
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setCurrent(m)}>
                  <Play className="size-3.5 shrink-0" />
                  <span className="font-mono text-xs">
                    {formatTimestamp(m.start)}–{formatTimestamp(m.end)}
                  </span>
                  <span className="rounded px-1.5 text-[11px] font-medium text-black" style={{ background: TYPE_COLOR[m.type] ?? '#ccc' }}>
                    {m.typeLabel}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{m.emotes.join(' ')}</span>
                </button>
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {m.chatPerMin} msg/min{m.comments ? ` · ${m.comments} coment.` : ''}
                </span>
                <Badge variant={m.score >= 60 ? 'success' : m.score >= 45 ? 'default' : 'secondary'}>{m.score}</Badge>
              </div>
            ))}
            <div className="space-y-1 pt-2">
              <Button
                disabled={!picked.size || approving}
                onClick={async () => {
                  setApproving(true);
                  setApproveError(null);
                  try {
                    const r = await api<{ job: { id: string } }>(`/api/vods/${id}/approve`, { method: 'POST', body: JSON.stringify({ ranks: [...picked] }) });
                    router.push(`/jobs/${r.job.id}`);
                  } catch (e) {
                    setApproveError((e as Error).message);
                    setApproving(false);
                  }
                }}
              >
                {approving ? <Loader2 className="animate-spin" /> : <Download />} Aprovar {picked.size} momento(s) e gerar os cortes
              </Button>
              <p className="text-xs text-muted-foreground">Baixa só esses trechos (com 15 s de margem de cada lado), junta num vídeo e roda o pipeline de cortes com as configurações do formulário.</p>
              {approveError && <p className="text-xs text-destructive">{approveError}</p>}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function HeatChart({ data, mode, moments, current, onPick, picked }: { data: Peaks; mode: Mode; moments: Moment[]; current: Moment | null; onPick: (m: Moment) => void; picked: Set<number> }) {
  const W = 1000;
  const H = 180;
  const dur = Math.max(1, data.meta.duration);
  const x = (t: number) => (t / dur) * W;
  const y = (s: number) => H - Math.min(1, s) * (H - 30);
  const line = (v: (p: Peaks['series'][number]) => number) => data.series.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v(p)).toFixed(1)}`).join(' ');
  // "Só comentários" pinta o calor pelos comentários; nos outros, a linha ciano mostra os comentários por cima
  const path = line((p) => (mode === 'comments' ? (p.m ?? 0) : p.s));
  const commentPath = mode !== 'comments' && data.series.some((p) => p.m) ? line((p) => p.m ?? 0) : null;
  const step = dur > 3 * 3600 ? 1800 : dur > 3600 ? 600 : 300;
  return (
    <svg viewBox={`0 0 ${W} ${H + 22}`} className="w-full">
      <defs>
        <linearGradient id="heat" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#2563eb" stopOpacity="0.5" />
          <stop offset="60%" stopColor="#f59e0b" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#ef4444" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      {Array.from({ length: Math.floor(dur / step) + 1 }, (_, i) => i * step).map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={0} y2={H} stroke="currentColor" strokeOpacity="0.08" />
          <text x={x(t)} y={H + 16} fontSize="10" textAnchor="middle" fill="currentColor" opacity="0.5">
            {formatTimestamp(t)}
          </text>
        </g>
      ))}
      <path d={`${path} L${W},${H} L0,${H} Z`} fill="url(#heat)" />
      <path d={path} fill="none" stroke="currentColor" strokeOpacity="0.6" strokeWidth="0.8" />
      {commentPath && <path d={commentPath} fill="none" stroke="#22d3ee" strokeOpacity="0.4" strokeWidth="0.7" />}
      {moments.map((m, i) => (
        <g key={m.rank} className="cursor-pointer" onClick={() => onPick(m)} opacity={picked.has(m.rank) ? 1 : 0.35}>
          <rect x={x(m.start)} y={H - 4} width={Math.max(2, x(m.end) - x(m.start))} height={4} fill={TYPE_COLOR[m.type] ?? '#facc15'} />
          <circle cx={x(m.peak)} cy={Math.max(12, y(m.score / 100) - 12)} r={10} fill={current?.rank === m.rank ? '#fff' : (TYPE_COLOR[m.type] ?? '#facc15')} />
          <text x={x(m.peak)} y={Math.max(12, y(m.score / 100) - 12) + 3.5} fontSize="10" fontWeight="700" textAnchor="middle" fill="#111">
            {i + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}
