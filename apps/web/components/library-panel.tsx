'use client';
import { useEffect, useRef, useState } from 'react';
import { FolderPlus, Image as ImageIcon, Laugh, Loader2, Music, RefreshCw, Trash2, UploadCloud } from 'lucide-react';
import type { LibraryIndex } from '@clipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton, SkeletonVideo } from '@/components/ui/skeleton';
import { api, fileUrl } from '@/lib/client';

interface LibraryResponse {
  library: LibraryIndex;
  dirs: Record<keyof LibraryIndex, string>;
}
type Kind = keyof LibraryIndex;

const KINDS: { key: Kind; label: string; icon: React.ReactNode; accept: string }[] = [
  { key: 'memes', label: 'Memes', icon: <Laugh className="size-4" />, accept: 'image/*,video/*' },
  { key: 'audio', label: 'Áudios / SFX', icon: <Music className="size-4" />, accept: 'audio/*' },
  { key: 'images', label: 'Imagens', icon: <ImageIcon className="size-4" />, accept: 'image/*' },
];

export function useLibrary() {
  const [data, setData] = useState<LibraryResponse | null>(null);
  const refresh = () => api<LibraryResponse>('/api/library').then(setData).catch(() => undefined);
  useEffect(() => {
    refresh();
  }, []);
  return { data, refresh };
}

/** Upload de um arquivo para uma pasta da biblioteca (XHR para ter progresso). */
function uploadToLibrary(file: File, kind: Kind, folder: string, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/library/upload');
    xhr.setRequestHeader('x-kind', kind);
    xhr.setRequestHeader('x-folder', encodeURIComponent(folder));
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(JSON.parse(xhr.responseText || '{}').error ?? `HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('Falha de rede no upload'));
    xhr.send(file);
  });
}

const joinPath = (dir: string, ...parts: string[]) => [dir.replace(/[\\/]+$/, ''), ...parts].join(dir.includes('\\') ? '\\' : '/');

export function LibraryPanel({ detailed = false }: { detailed?: boolean }) {
  const { data, refresh } = useLibrary();
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle>Biblioteca local</CardTitle>
          <CardDescription>Arquivos usados pela IA nos planos de edição.</CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={refresh} title="Reescanear pastas">
          <RefreshCw />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data &&
          KINDS.map((k) => (
            <div key={k.key} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <div className="flex gap-1.5">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-5 w-24" />
              </div>
            </div>
          ))}
        {data &&
          KINDS.map((k) => {
            const cats = data.library[k.key];
            const total = cats.reduce((a, c) => a + c.files.length, 0);
            return (
              <div key={k.key} className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className="text-primary">{k.icon}</span>
                  {k.label}
                  <span className="ml-auto text-xs text-muted-foreground">{total} arquivo(s)</span>
                </div>
                {!detailed && (
                  <div className="flex flex-wrap gap-1.5">
                    {cats.map((c) => (
                      <span key={c.name} className="rounded-md border bg-muted/40 px-2 py-0.5 text-xs">
                        /{c.name} <span className="text-muted-foreground">· {c.files.length}</span>
                      </span>
                    ))}
                    {!cats.length && <span className="text-xs text-muted-foreground">vazio</span>}
                  </div>
                )}
                {detailed && <KindSection kind={k.key} accept={k.accept} dir={data.dirs[k.key]} cats={cats} onChanged={refresh} />}
              </div>
            );
          })}
        {!detailed && (
          <p className="text-xs text-muted-foreground">
            Adicione arquivos e pastas na aba <b>Biblioteca</b>. Cada pasta vira uma categoria.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function KindSection({ kind, accept, dir, cats, onChanged }: { kind: Kind; accept: string; dir: string; cats: LibraryIndex[Kind]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function createFolder() {
    setError(null);
    try {
      await api('/api/library/folder', { method: 'POST', body: JSON.stringify({ kind, name }) });
      setName('');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // A raiz ("_geral") sempre aparece, para dar para enviar sem criar pasta
  const all = cats.some((c) => c.name === '_geral') ? cats : [{ name: '_geral', files: [] }, ...cats];
  return (
    <div className="space-y-2 pl-1">
      <p className="break-all font-mono text-[11px] text-muted-foreground">{dir}</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) createFolder();
        }}
      >
        <Input className="h-8 text-xs" placeholder="Nome da nova pasta (ex.: risadas)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" size="sm" variant="outline" disabled={!name.trim()}>
          <FolderPlus /> Nova pasta
        </Button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {all.map((c) => (
        <Folder key={c.name} kind={kind} accept={accept} dir={dir} name={c.name} files={c.files} onChanged={onChanged} />
      ))}
    </div>
  );
}

function Folder({ kind, accept, dir, name, files, onChanged }: { kind: Kind; accept: string; dir: string; name: string; files: string[]; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ n: number; total: number; p: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  // Prévias só carregam com a pasta aberta (pastas com dezenas de imagens)
  const [open, setOpen] = useState(false);

  async function send(list: FileList | null) {
    if (!list?.length) return;
    setError(null);
    const arr = [...list];
    try {
      for (let i = 0; i < arr.length; i++) {
        setUpload({ n: i + 1, total: arr.length, p: 0 });
        await uploadToLibrary(arr[i], kind, name, (p) => setUpload({ n: i + 1, total: arr.length, p }));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUpload(null);
      onChanged();
    }
  }
  async function remove(file: string) {
    if (!confirm(`Apagar "${file}" da biblioteca?`)) return;
    try {
      await api(`/api/library?kind=${kind}&folder=${encodeURIComponent(name)}&file=${encodeURIComponent(file)}`, { method: 'DELETE' });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const path = (f: string) => (name === '_geral' ? joinPath(dir, f) : joinPath(dir, name, f));

  return (
    <details
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={`rounded-md border px-3 py-2 transition-colors ${drag ? 'border-primary bg-primary/5' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        send(e.dataTransfer.files);
      }}
    >
      <summary className="flex cursor-pointer items-center gap-2 text-sm">
        <span className="flex-1">
          /{name === '_geral' ? ' (sem pasta)' : name} <span className="text-muted-foreground">({files.length})</span>
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="h-7"
          disabled={!!upload}
          onClick={(e) => {
            e.preventDefault();
            input.current?.click();
          }}
        >
          {upload ? <Loader2 className="animate-spin" /> : <UploadCloud />}
          {upload ? `${upload.n}/${upload.total} · ${Math.round(upload.p * 100)}%` : 'Enviar arquivos'}
        </Button>
        <input ref={input} type="file" multiple accept={accept} className="hidden" onChange={(e) => (send(e.target.files), (e.target.value = ''))} />
      </summary>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className={kind === 'audio' ? 'mt-2 space-y-1.5' : 'mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4'}>
        {open && files.map((f) =>
          kind === 'audio' ? (
            <div key={f} className="group flex items-center gap-2 rounded-md border px-2 py-1 transition-colors hover:bg-accent">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{f}</span>
              <audio src={fileUrl(path(f))} controls preload="none" className="h-7 w-48" />
              <DeleteButton onClick={() => remove(f)} />
            </div>
          ) : (
            <div key={f} className="group relative overflow-hidden rounded-md border transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-md" title={f}>
              <Thumb src={fileUrl(path(f))} video={/\.(mp4|webm|mov)$/i.test(f)} />
              <p className="truncate px-1.5 py-1 font-mono text-[10px] text-muted-foreground">{f}</p>
              <div className="absolute right-1 top-1 opacity-0 transition-opacity group-hover:opacity-100">
                <DeleteButton onClick={() => remove(f)} />
              </div>
            </div>
          ),
        )}
        {!files.length && <p className="col-span-full text-xs text-muted-foreground">Pasta vazia — clique em “Enviar arquivos” ou arraste para cá.</p>}
      </div>
    </details>
  );
}

function Thumb({ src, video }: { src: string; video: boolean }) {
  const [ready, setReady] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // Imagem em cache pode terminar de carregar antes do React ligar o onLoad
  useEffect(() => {
    if (img.current?.complete) setReady(true);
  }, []);
  if (video) return <SkeletonVideo src={src} muted loop playsInline preload="metadata" wrapperClassName="aspect-square bg-black" className="size-full object-cover" onMouseEnter={(e) => e.currentTarget.play()} onMouseLeave={(e) => e.currentTarget.pause()} />;
  return (
    <div className="relative aspect-square bg-black/40">
      {!ready && <Skeleton className="absolute inset-0 rounded-none" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={img} src={src} alt="" onLoad={() => setReady(true)} onError={() => setReady(true)} className={`size-full object-contain transition-opacity duration-500 ${ready ? 'opacity-100' : 'opacity-0'}`} />
    </div>
  );
}

function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded bg-black/60 p-1 text-white transition-colors hover:bg-red-600" title="Apagar">
      <Trash2 className="size-3.5" />
    </button>
  );
}
