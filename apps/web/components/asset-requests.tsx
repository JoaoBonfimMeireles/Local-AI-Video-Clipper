'use client';

import { useEffect, useState } from 'react';
import { ImagePlus, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { formatTimestamp, type AssetRequest } from '@clipper/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/client';

interface Data {
  concept: string;
  clips: { index: number; title: string; variant: string | null; requests: (AssetRequest & { uploaded: string | null })[] }[];
}

const KIND: Record<AssetRequest['kind'], string> = { image: 'Imagem', meme: 'Meme', sound: 'Som' };
const DISPLAY: Record<AssetRequest['display'], string> = { full: 'tela inteira', corner: 'quadro no canto', top: 'por cima da câmera' };

/**
 * Sessão "a partir de um corte viral": a fórmula que a IA entendeu, o que cada versão muda e o material pedido
 * (imagem, meme, som) com o botão de envio. Depois de mandar, "Renderizar de novo" refaz os vídeos com o material.
 */
export function AssetRequests({ jobId, canRerender }: { jobId: string; canRerender: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => api<Data>(`/api/jobs/${jobId}/requests`).then(setData).catch(() => undefined);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  if (!data || (!data.concept && !data.clips.length)) return null;
  const total = data.clips.reduce((a, c) => a + c.requests.length, 0);
  const sent = data.clips.reduce((a, c) => a + c.requests.filter((r) => r.uploaded).length, 0);

  async function upload(requestId: string, file: File) {
    setBusy(requestId);
    setMsg(null);
    try {
      const form = new FormData();
      form.set('requestId', requestId);
      form.set('file', file);
      const res = await fetch(`/api/jobs/${jobId}/requests`, { method: 'POST', body: form });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function remove(requestId: string) {
    await api(`/api/jobs/${jobId}/requests?requestId=${encodeURIComponent(requestId)}`, { method: 'DELETE' }).catch(() => undefined);
    await load();
  }
  async function rerender() {
    setBusy('rerender');
    try {
      await api(`/api/jobs/${jobId}/retry`, { method: 'POST' });
      setMsg('Job reenviado: os mesmos cortes serão renderizados de novo com o material enviado.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ImagePlus className="size-4 text-primary" /> Corte viral: fórmula e material
        </CardTitle>
        <CardDescription>
          {total ? `${sent} de ${total} pedido(s) com material. Pedidos sem arquivo ficam de fora do vídeo.` : 'Job só de cortes: a IA não pediu material.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.concept && (
          <div className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-line">
            <div className="mb-1 text-xs font-semibold text-muted-foreground">O que a IA entendeu do corte de referência</div>
            {data.concept}
          </div>
        )}
        {data.clips.map((c) => (
          <div key={c.index} className="space-y-2 rounded-lg border p-3">
            <div className="text-sm font-semibold">
              Corte {c.index + 1}: {c.title}
            </div>
            {c.variant && <div className="text-xs text-muted-foreground">{c.variant}</div>}
            {c.requests.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/30 px-2.5 py-2 text-sm">
                <Badge variant="outline">{KIND[r.kind]}</Badge>
                <span className="font-mono text-xs">{formatTimestamp(r.at)}</span>
                <span className="min-w-40 flex-1">
                  {r.what} <span className="text-xs text-muted-foreground">({DISPLAY[r.display]}, {r.duration.toFixed(1)}s){r.reason ? ` — ${r.reason}` : ''}</span>
                </span>
                {r.uploaded ? (
                  <>
                    <Badge>enviado</Badge>
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="Remover arquivo" onClick={() => remove(r.id)}>
                      <Trash2 />
                    </Button>
                  </>
                ) : null}
                <label className="cursor-pointer rounded-md border bg-background px-2.5 py-1 text-xs hover:bg-accent/40">
                  {busy === r.id ? <Loader2 className="inline size-3 animate-spin" /> : r.uploaded ? 'Trocar' : 'Enviar arquivo'}
                  <input
                    type="file"
                    className="hidden"
                    accept={r.kind === 'sound' ? 'audio/*' : 'image/*,video/*,.gif'}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) upload(r.id, f);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            ))}
          </div>
        ))}
        {total > 0 && (
          <Button onClick={rerender} disabled={!canRerender || !sent || busy === 'rerender'}>
            {busy === 'rerender' ? <Loader2 className="animate-spin" /> : <RotateCcw />} Renderizar de novo com o material
          </Button>
        )}
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      </CardContent>
    </Card>
  );
}
