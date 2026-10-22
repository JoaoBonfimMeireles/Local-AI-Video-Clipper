'use client';
import { useEffect, useState } from 'react';
import { Image as ImageIcon, Laugh, Music, RefreshCw } from 'lucide-react';
import type { LibraryIndex } from '@clipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/client';

interface LibraryResponse {
  library: LibraryIndex;
  dirs: Record<keyof LibraryIndex, string>;
}

const KINDS: { key: keyof LibraryIndex; label: string; icon: React.ReactNode }[] = [
  { key: 'memes', label: 'Memes', icon: <Laugh className="size-4" /> },
  { key: 'audio', label: 'Áudios / SFX', icon: <Music className="size-4" /> },
  { key: 'images', label: 'Imagens', icon: <ImageIcon className="size-4" /> },
];

export function useLibrary() {
  const [data, setData] = useState<LibraryResponse | null>(null);
  const refresh = () => api<LibraryResponse>('/api/library').then(setData).catch(() => undefined);
  useEffect(() => {
    refresh();
  }, []);
  return { data, refresh };
}

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
        {!data && <p className="text-sm text-muted-foreground">Carregando…</p>}
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
                <div className="flex flex-wrap gap-1.5">
                  {cats.map((c) => (
                    <span key={c.name} className="rounded-md border bg-muted/40 px-2 py-0.5 text-xs">
                      /{c.name} <span className="text-muted-foreground">· {c.files.length}</span>
                    </span>
                  ))}
                  {!cats.length && <span className="text-xs text-muted-foreground">vazio</span>}
                </div>
                {detailed && (
                  <div className="space-y-2 pl-1">
                    <p className="break-all font-mono text-[11px] text-muted-foreground">{data.dirs[k.key]}</p>
                    {cats.map((c) => (
                      <details key={c.name} className="rounded-md border px-3 py-2">
                        <summary className="cursor-pointer text-sm">
                          /{c.name} ({c.files.length})
                        </summary>
                        <ul className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                          {c.files.map((f) => (
                            <li key={f} className="truncate font-mono">
                              {f}
                            </li>
                          ))}
                          {!c.files.length && <li>pasta vazia</li>}
                        </ul>
                      </details>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        {!detailed && (
          <p className="text-xs text-muted-foreground">
            Adicione arquivos em <code>data/memes/&lt;categoria&gt;</code>, <code>data/audio/&lt;categoria&gt;</code> e <code>data/images</code>. Novas subpastas viram categorias.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
