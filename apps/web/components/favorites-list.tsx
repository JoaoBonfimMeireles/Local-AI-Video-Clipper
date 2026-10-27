'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Download, FileJson, FileText, Loader2, Pencil, Star, Trash2 } from 'lucide-react';
import type { Favorite } from '@clipper/shared';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ClipAssets, LanguageDownloads, PostText, YoutubeKit, revisionActive, ReviseBox, RevisionBanner, type RevisionStatus } from '@/components/job-detail';
import { api, fileUrl } from '@/lib/client';
import { cn } from '@/lib/utils';
import { SpeedPicker } from '@/components/speed-picker';

interface FavoritesResponse {
  favorites: Favorite[];
  revisions: Record<string, RevisionStatus>;
}

const fmtDay = (iso: string) => {
  const t = new Date(iso).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function FavoritesList() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<FavoritesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const qs = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
        const r = await api<FavoritesResponse>(`/api/favorites?${qs}`);
        if (!alive) return;
        setData(r);
        setError(null);
        timer = setTimeout(tick, Object.values(r.revisions).some(revisionActive) ? 1500 : 8000);
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
        timer = setTimeout(tick, 5000);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [from, to]);

  const q = query.trim().toLowerCase();
  const list = (data?.favorites ?? []).filter((f) => !q || `${f.title} ${f.description ?? ''} ${f.hashtags.join(' ')} ${f.videoName}`.toLowerCase().includes(q));
  // Agrupa pelo dia em que foi favoritado
  const groups = list.reduce<{ day: string; items: Favorite[] }[]>((acc, f) => {
    const day = localDay(f.favoritedAt);
    const g = acc.find((x) => x.day === day);
    if (g) g.items.push(f);
    else acc.push({ day, items: [f] });
    return acc;
  }, []);

  const remove = async (f: Favorite) => {
    if (!confirm(`Remover "${f.title}" dos favoritos? A cópia guardada será apagada.`)) return;
    await api(`/api/favorites/${f.id}`, { method: 'DELETE' }).catch((e) => alert((e as Error).message));
    setData((d) => d && { ...d, favorites: d.favorites.filter((x) => x.id !== f.id) });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          Favoritados de
          <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          até
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </label>
        <label className="min-w-48 flex-1 space-y-1 text-xs text-muted-foreground">
          Buscar
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="título, descrição, hashtag ou vídeo de origem" />
        </label>
        {(from || to || query) && (
          <Button variant="ghost" size="sm" onClick={() => (setFrom(''), setTo(''), setQuery(''))}>
            Limpar filtros
          </Button>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!data && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {data && !list.length && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            <Star className="mx-auto mb-2 size-6" />
            {data.favorites.length ? 'Nenhum favorito com esses filtros.' : 'Nenhum favorito ainda. Clique na estrela de um corte pronto para guardá-lo aqui.'}
          </CardContent>
        </Card>
      )}

      {groups.map((g) => (
        <section key={g.day} className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">
            {fmtDay(g.items[0].favoritedAt)} · {g.items.length} favorito(s)
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map((f) => (
              <FavoriteCard key={f.id} fav={f} revision={data?.revisions[f.id]} onRemove={() => remove(f)} onRevise={(rev) => setData((d) => d && { ...d, revisions: { ...d.revisions, [f.id]: rev } })} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function FavoriteCard({ fav, revision, onRemove, onRevise }: { fav: Favorite; revision?: RevisionStatus; onRemove: () => void; onRevise: (rev: RevisionStatus) => void }) {
  const revising = revisionActive(revision);
  const editAction = useEditAction(fav.metadataPath);
  const thumb = fav.videoPath.replace(/\.mp4$/, '.jpg');
  return (
    <Card className={cn('overflow-hidden', revising && 'ring-2 ring-primary/50')}>
      <div className="relative grid aspect-video place-items-center bg-black/50">
        {revising && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-black/60 text-sm text-white">
            <span className="flex items-center gap-2">
              <Loader2 className="size-5 animate-spin" /> {revision!.status === 'pending' ? 'Na fila…' : `Ajustando ${(revision!.progress * 100).toFixed(0)}%`}
            </span>
          </div>
        )}
        <video key={fav.videoPath} src={fileUrl(fav.videoPath)} poster={fileUrl(thumb)} controls preload="none" className="h-full max-h-[420px] w-full object-contain" />
      </div>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-start gap-2">
          <Star className="mt-0.5 size-4 shrink-0 fill-yellow-400 text-yellow-400" />
          <p className="flex-1 text-sm font-medium leading-snug">{fav.title}</p>
          <button type="button" onClick={onRemove} title="Remover dos favoritos" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive">
            <Trash2 className="size-4" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Favoritado em {new Date(fav.favoritedAt).toLocaleDateString('pt-BR')} às {fmtTime(fav.favoritedAt)} · {fav.duration.toFixed(0)}s
        </p>
        <p className="truncate text-xs text-muted-foreground" title={fav.videoName}>
          Vídeo de origem:{' '}
          <Link href={`/jobs/${fav.jobId}`} className="underline-offset-2 hover:underline">
            {fav.videoName}
          </Link>
        </p>
        <SpeedPicker />
        {(fav.description || fav.hashtags.length > 0) && <PostText clip={fav} />}
        {editAction === null && <ClipAssets key={fav.metadataPath} metadataPath={fav.metadataPath} />}
        <YoutubeKit key={`y${fav.metadataPath}`} metadataPath={fav.metadataPath} />
        <LanguageDownloads key={`l${fav.metadataPath}`} metadataPath={fav.metadataPath} />
        {revision && <RevisionBanner rev={revision} onRetried={onRevise} />}
        {editAction === undefined ? null : editAction ? <EditButton action={editAction} /> : !revising && <ReviseBox endpoint={`/api/favorites/${fav.id}/revise`} onQueued={onRevise} />}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <a className={buttonVariants({ size: 'sm' })} href={fileUrl(fav.videoPath, true)}>
            <Download /> MP4
          </a>
          {fav.srtPath && (
            <a className={buttonVariants({ size: 'sm', variant: 'outline' })} href={fileUrl(fav.srtPath, true)}>
              <FileText /> SRT
            </a>
          )}
          <a className={buttonVariants({ size: 'sm', variant: 'outline' })} href={fileUrl(fav.metadataPath)} target="_blank" rel="noreferrer">
            <FileJson /> JSON
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

type EditAction = { type: 'meme'; url: string } | { type: 'clean'; jobId: string };

/** Vídeos editados (compilado / vídeo limpo) guardam no clip.json como reabrir a edição. undefined = carregando. */
function useEditAction(metadataPath: string): EditAction | null | undefined {
  const [action, setAction] = useState<EditAction | null | undefined>(undefined);
  useEffect(() => {
    fetch(fileUrl(metadataPath))
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => setAction(m?.editAction ?? null))
      .catch(() => setAction(null));
  }, [metadataPath]);
  return action;
}

function EditButton({ action }: { action: EditAction }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function go() {
    if (action.type === 'meme') return router.push(action.url);
    // Vídeo limpo: copia para data/input e abre no Painel
    setBusy(true);
    try {
      const r = await api<{ name: string }>('/api/clean/send', { method: 'POST', body: JSON.stringify({ jobId: action.jobId }) });
      router.push(`/?file=${encodeURIComponent(r.name)}`);
    } catch (e) {
      alert((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Button size="sm" variant="secondary" className="w-full" onClick={go} disabled={busy}>
      {busy ? <Loader2 className="animate-spin" /> : <Pencil />}
      {action.type === 'meme' ? 'Editar no Editor de vídeo' : 'Levar para o editor'}
    </Button>
  );
}
