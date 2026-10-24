'use client';
// Edição manual de um corte pronto: ajusta à mão o que a IA decidiu (trechos, rosto/enquadramento, zooms,
// memes e sons) e manda renderizar de novo — sem chamar a IA no plano.
import { useEffect, useMemo, useState } from 'react';
import { Clock, Loader2, Minus, Play, Plus, Search, Trash2, X } from 'lucide-react';
import type { Clip, FrameBox, LibraryIndex, ManualEdit, ManualFrame } from '@clipper/shared';
import { defaultFrames, FramingEditor, LivePreview, useClipPlayer, type PreviewOverlay } from '@/components/manual-preview';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api, fileUrl } from '@/lib/client';
import { cn } from '@/lib/utils';

type Overlay = ManualEdit['overlays'][number];
type Sfx = ManualEdit['sfx'][number];

interface ClipMeta {
  duration: number;
  format?: string;
  resolution?: string;
  edit?: { shots?: any[]; zooms?: any[]; overlays?: any[]; sfx?: any[]; frames?: ManualFrame[] | null };
  renderContext?: { input: string; segments: ManualEdit['segments']; layout?: { cam?: FrameBox | null; content?: FrameBox | null; gameplay?: boolean } | null };
}

const POSITIONS: { value: Overlay['position']; label: string }[] = [
  { value: 'top', label: 'Em cima' },
  { value: 'top-left', label: 'Em cima, esquerda' },
  { value: 'top-right', label: 'Em cima, direita' },
  { value: 'center', label: 'Centro' },
  { value: 'bottom', label: 'Embaixo' },
];

const r1 = (n: number) => Math.round(n * 10) / 10;

export function prettyAsset(file: string): string {
  let name = file.replace(/\.[a-z0-9]{2,4}$/i, '');
  try {
    if (/%[0-9a-f]{2}/i.test(name)) name = decodeURIComponent(name);
  } catch {
    /* nome com % truncado */
  }
  return (
    name
      .split(/[\s\-_]+/)
      .filter((w) => w && !/^(meme|green|screen|greenscreen|template|small)$/i.test(w))
      .join(' ') || file
  );
}

function fromMeta(meta: ClipMeta): ManualEdit {
  const e = meta.edit ?? {};
  return {
    segments: (meta.renderContext?.segments ?? []).map((s) => ({ start: s.start, end: s.end, label: s.label ?? null })),
    shots: (e.shots ?? []).map((s) => ({ at: s.at, duration: s.duration, type: s.type ?? 'focus', focusX: s.focusX ?? 0.5, focusY: s.focusY ?? 0.45, scale: s.scale ?? 1 })),
    zooms: (e.zooms ?? []).map((z) => ({ at: z.at, duration: z.duration, scale: z.scale, focusX: z.focusX ?? 0.5, focusY: z.focusY ?? 0.4 })),
    overlays: (e.overlays ?? []).map((o) => ({ type: o.type === 'image' ? 'image' : 'meme', category: o.category ?? '_geral', file: o.file, at: o.at, duration: o.duration, position: o.position ?? 'top', scale: o.scale ?? 0.5, audioMode: o.audioMode ?? 'both' })),
    sfx: (e.sfx ?? []).map((x) => ({ category: x.category ?? '_geral', file: x.file, at: x.at, volume: x.volume ?? 0.8, duration: x.duration })),
    camZoom: 1,
  };
}

export function ManualEditor({ clip, onClose, onQueued }: { clip: Clip; onClose: () => void; onQueued: (jobId: string, createdAt: string) => void }) {
  const [meta, setMeta] = useState<ClipMeta | null>(null);
  const [draft, setDraft] = useState<ManualEdit | null>(null);
  const [lib, setLib] = useState<{ library: LibraryIndex; dirs: Record<'memes' | 'audio' | 'images', string> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clip.metadataPath) return;
    fetch(fileUrl(clip.metadataPath))
      .then((r) => r.json())
      .then((m: ClipMeta) => {
        setMeta(m);
        setDraft(fromMeta(m));
      })
      .catch(() => setError('Não consegui ler os dados deste corte.'));
    api<{ library: LibraryIndex; dirs: Record<'memes' | 'audio' | 'images', string> }>('/api/library').then(setLib).catch(() => undefined);
  }, [clip.metadataPath]);

  const segments = useMemo(() => draft?.segments ?? [], [draft?.segments]);
  // Vídeo da prévia: o original ou uma cópia leve (VOD em MPEG-TS não toca no navegador)
  const [source, setSource] = useState<{ path: string; offset: number } | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  useEffect(() => {
    api<{ path: string; offset: number }>(`/api/jobs/${clip.jobId}/clips/${clip.index}/preview-source`).then(setSource).catch((e) => setSourceError((e as Error).message));
  }, [clip.jobId, clip.index]);
  const player = useClipPlayer(segments, source?.offset ?? 0, !!source);
  const total = player.total;
  const now = () => r1(Math.min(Math.max(0, player.now()), Math.max(0, total - 0.3)));
  const seek = (t: number) => player.seek(t);
  const [W, H] = (meta?.resolution ?? '1080x1920').split('x').map(Number);
  // Enquadramento: o que a IA fez vira quadros editáveis assim que o vídeo original carrega
  const [framesTouched, setFramesTouched] = useState(false);
  useEffect(() => {
    if (!meta || !draft || draft.frames || !player.vw) return;
    const frames = meta.edit?.frames?.length
      ? meta.edit.frames
      : defaultFrames({ layout: meta.renderContext?.layout ?? null, shots: draft.shots, format: meta.format ?? 'vertical_blur', W, H }, total, player.vw, player.vh);
    setDraft((d) => (d ? { ...d, frames } : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, draft?.frames, player.vw]);
  const libPath = (kind: 'memes' | 'audio' | 'images', category: string, file: string) => {
    const dir = lib?.dirs[kind] ?? '';
    const sep = dir.includes('\\') ? '\\' : '/';
    return category === '_geral' ? `${dir}${sep}${file}` : `${dir}${sep}${category}${sep}${file}`;
  };

  function update(patch: (d: ManualEdit) => ManualEdit) {
    setDraft((d) => (d ? patch(structuredClone(d)) : d));
  }

  /** Mudar o começo do 1º trecho desloca tudo que vem depois (memes continuam na mesma fala). */
  function moveSegment(i: number, edge: 'start' | 'end', delta: number) {
    update((d) => {
      const sg = d.segments[i];
      const before = sg[edge];
      sg[edge] = r1(Math.max(0, sg[edge] + delta));
      if (sg.end - sg.start < 1) sg[edge] = before;
      // Tirar/ganhar tempo no começo de um trecho desloca os itens dele e dos seguintes
      const shift = edge === 'start' ? -(sg.start - before) : 0;
      if (shift) {
        const offset = d.segments.slice(0, i).reduce((a, s) => a + (s.end - s.start), 0);
        const mv = <T extends { at: number }>(x: T) => (x.at >= offset ? { ...x, at: r1(Math.max(offset, x.at + shift)) } : x);
        d.overlays = d.overlays.map(mv);
        d.sfx = d.sfx.map(mv);
        d.zooms = d.zooms.map(mv);
        d.shots = d.shots.map(mv);
      }
      return d;
    });
  }

  async function save() {
    if (!draft) return;
    // Só manda o enquadramento se ele foi mexido (ou já era manual); senão o render mantém o da IA
    const frames = framesTouched || meta?.edit?.frames?.length ? fitFrames(draft.frames ?? [], total) : undefined;
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ job: { id: string; createdAt: string } }>(`/api/jobs/${clip.jobId}/clips/${clip.index}/manual`, { method: 'POST', body: JSON.stringify({ ...draft, frames }) });
      onQueued(r.job.id, r.job.createdAt);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const previewOverlays: PreviewOverlay[] = useMemo(
    () =>
      (draft?.overlays ?? []).map((o) => ({
        key: `${o.category}/${o.file}`,
        url: fileUrl(libPath(o.type === 'image' ? 'images' : 'memes', o.category, o.file)),
        at: o.at,
        duration: o.duration,
        position: o.position,
        scale: o.scale,
        audioMode: o.audioMode,
        video: /.(mp4|webm|mov)$/i.test(o.file),
        greenScreen: /green|chroma/i.test(o.file),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft?.overlays, lib],
  );
  const previewSfx = useMemo(() => (draft?.sfx ?? []).map((x) => ({ url: fileUrl(libPath('audio', x.category, x.file)), at: x.at, volume: x.volume })), [draft?.sfx, lib]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 p-2 sm:p-6" onClick={onClose}>
      <div className="flex w-full max-w-6xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate font-semibold">Editar corte #{String(clip.index + 1).padStart(3, '0')} — {clip.title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} title="Fechar">
            <X />
          </Button>
        </div>

        {!draft ? (
          <div className="grid flex-1 place-items-center p-10 text-muted-foreground">{error ?? <Loader2 className="animate-spin" />}</div>
        ) : (
          <div className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,320px)_1fr]">
            {/* Prévia ao vivo: vídeo original + enquadramento, zooms, memes e sons como vão sair */}
            <div className="space-y-2 overflow-y-auto border-b p-4 lg:border-r lg:border-b-0">
              {source && <video ref={player.video} src={fileUrl(source.path)} preload="auto" playsInline className="hidden" />}
              {sourceError ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{sourceError}</p>
              ) : draft.frames?.length ? (
                <LivePreview player={player} frames={draft.frames} zooms={draft.zooms} overlays={previewOverlays} sfx={previewSfx} W={W} H={H} />
              ) : (
                <div className="grid aspect-[9/16] w-full max-w-[300px] place-items-center rounded-lg bg-black p-4 text-center text-xs text-muted-foreground">
                  <span>
                    <Loader2 className="mx-auto mb-2 animate-spin" />
                    {source ? 'Carregando o vídeo…' : 'Preparando a prévia (só na primeira vez, pode levar 1 minuto)…'}
                  </span>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                A prévia mostra <b>na hora</b> o enquadramento, os zooms, os memes e os sons (legendas e placar só aparecem no vídeo final). Pause onde quiser e use <Clock className="inline size-3" />{' '}
                <b>agora</b> para levar um item para esse instante.
              </p>
              <p className="text-xs text-muted-foreground">
                Duração final: <b className="text-foreground">{total.toFixed(1)}s</b>
              </p>
            </div>

            <div className="space-y-5 overflow-y-auto p-4 pb-24">
              <Section title="Enquadramento" hint="Escolha o que aparece na tela em cada parte do corte: arraste e redimensione as caixas sobre o vídeo original.">
                {draft.frames?.length ? (
                  <FramingEditor
                    player={player}
                    frames={draft.frames}
                    W={W}
                    H={H}
                    onChange={(frames) => {
                      setFramesTouched(true);
                      update((d) => ({ ...d, frames }));
                    }}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">Carregando o vídeo original…</p>
                )}
              </Section>

              <Section title="Tamanho do corte" hint="Comece antes ou depois e termine antes ou depois. Cada clique move meio segundo.">
                {draft.segments.map((sg, i) => (
                  <div key={i} className="space-y-1.5 rounded-lg border p-2.5">
                    {draft.segments.length > 1 && <p className="text-xs font-medium">{sg.label ? sg.label : `Trecho ${i + 1}`}</p>}
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Nudge label="Começo" value={sg.start} onMinus={() => moveSegment(i, 'start', -0.5)} onPlus={() => moveSegment(i, 'start', 0.5)} minusTitle="Começar antes" plusTitle="Começar depois" />
                      <Nudge label="Fim" value={sg.end} onMinus={() => moveSegment(i, 'end', -0.5)} onPlus={() => moveSegment(i, 'end', 0.5)} minusTitle="Terminar antes" plusTitle="Terminar depois" />
                    </div>
                  </div>
                ))}
              </Section>

              <Section
                title="Zooms"
                action={
                  <Button size="sm" variant="outline" onClick={() => update((d) => ({ ...d, zooms: [...d.zooms, { at: now(), duration: 2, scale: 1.2, focusX: 0.5, focusY: 0.4 }].sort((a, b) => a.at - b.at) }))}>
                    <Plus /> Zoom agora
                  </Button>
                }
              >
                {draft.zooms.map((z, i) => (
                  <Row key={i} onRemove={() => update((d) => ((d.zooms = d.zooms.filter((_, j) => j !== i)), d))}>
                    <TimeField value={z.at} onChange={(v) => update((d) => ((d.zooms[i].at = v), d))} onNow={() => update((d) => ((d.zooms[i].at = now()), d))} onSeek={() => seek(z.at)} />
                    <Slider label="Força" value={z.scale} min={1.05} max={2} step={0.05} format={(v) => `${v.toFixed(2)}x`} onChange={(v) => update((d) => ((d.zooms[i].scale = v), d))} />
                    <Slider label="Duração" value={z.duration} min={0.5} max={8} step={0.5} format={(v) => `${v}s`} onChange={(v) => update((d) => ((d.zooms[i].duration = v), d))} />
                  </Row>
                ))}
                {!draft.zooms.length && <Empty>Nenhum zoom.</Empty>}
              </Section>

              <Section title="Memes e imagens" action={<AssetPicker kinds={['memes', 'images']} lib={lib?.library} onPick={(kind, category, file) => update((d) => ({ ...d, overlays: [...d.overlays, { type: kind === 'images' ? 'image' : 'meme', category, file, at: now(), duration: 2.5, position: 'top', scale: 0.5, audioMode: 'both' } as Overlay].sort((a, b) => a.at - b.at) }))} label="Adicionar meme" />}>
                {draft.overlays.map((o, i) => (
                  <Row key={i} title={`${o.type === 'image' ? '🖼️' : '🎬'} ${prettyAsset(o.file)}`} onRemove={() => update((d) => ((d.overlays = d.overlays.filter((_, j) => j !== i)), d))}>
                    <TimeField value={o.at} onChange={(v) => update((d) => ((d.overlays[i].at = v), d))} onNow={() => update((d) => ((d.overlays[i].at = now()), d))} onSeek={() => seek(o.at)} />
                    <Slider label="Duração" value={o.duration} min={0.5} max={10} step={0.5} format={(v) => `${v}s`} onChange={(v) => update((d) => ((d.overlays[i].duration = v), d))} />
                    <Slider label="Tamanho" value={o.scale} min={0.15} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update((d) => ((d.overlays[i].scale = v), d))} />
                    <label className="space-y-1 text-xs">
                      <span className="text-muted-foreground">Posição</span>
                      <Select className="h-8 text-xs" value={o.position} onChange={(e) => update((d) => ((d.overlays[i].position = e.target.value as Overlay['position']), d))}>
                        {POSITIONS.map((p) => (
                          <option key={p.value} value={p.value}>
                            {p.label}
                          </option>
                        ))}
                      </Select>
                    </label>
                    {o.type === 'meme' && (
                      <label className="space-y-1 text-xs">
                        <span className="text-muted-foreground">Som do meme</span>
                        <Select className="h-8 text-xs" value={o.audioMode} onChange={(e) => update((d) => ((d.overlays[i].audioMode = e.target.value as Overlay['audioMode']), d))}>
                          <option value="both">Meme + fala</option>
                          <option value="meme">Só o meme</option>
                          <option value="video">Meme mudo</option>
                        </Select>
                      </label>
                    )}
                  </Row>
                ))}
                {!draft.overlays.length && <Empty>Nenhum meme ou imagem.</Empty>}
              </Section>

              <Section title="Sons" action={<AssetPicker kinds={['audio']} lib={lib?.library} onPick={(_, category, file) => update((d) => ({ ...d, sfx: [...d.sfx, { category, file, at: now(), volume: 0.8 } as Sfx].sort((a, b) => a.at - b.at) }))} onPreview={(c, f) => new Audio(fileUrl(libPath('audio', c, f))).play().catch(() => undefined)} label="Adicionar som" />}>
                {draft.sfx.map((x, i) => (
                  <Row
                    key={i}
                    title={`🔊 ${prettyAsset(x.file)}`}
                    extra={
                      <Button size="icon" variant="ghost" className="size-7" title="Ouvir" onClick={() => new Audio(fileUrl(libPath('audio', x.category, x.file))).play().catch(() => undefined)}>
                        <Play className="size-3.5" />
                      </Button>
                    }
                    onRemove={() => update((d) => ((d.sfx = d.sfx.filter((_, j) => j !== i)), d))}
                  >
                    <TimeField value={x.at} onChange={(v) => update((d) => ((d.sfx[i].at = v), d))} onNow={() => update((d) => ((d.sfx[i].at = now()), d))} onSeek={() => seek(x.at)} />
                    <Slider label="Volume" value={x.volume} min={0} max={1.5} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update((d) => ((d.sfx[i].volume = v), d))} />
                  </Row>
                ))}
                {!draft.sfx.length && <Empty>Nenhum som.</Empty>}
              </Section>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
          {error && draft && <p className="flex-1 text-xs text-destructive">{error}</p>}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={!draft || saving}>
              {saving ? <Loader2 className="animate-spin" /> : null} Renderizar com as mudanças
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ title, extra, onRemove, children }: { title?: string; extra?: React.ReactNode; onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border p-2.5">
      <div className="flex items-center gap-1">
        {title && <p className="min-w-0 flex-1 truncate text-xs font-medium">{title}</p>}
        {!title && <span className="flex-1" />}
        {extra}
        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" title="Remover" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function Nudge({ label, value, onMinus, onPlus, minusTitle, plusTitle }: { label: string; value: number; onMinus: () => void; onPlus: () => void; minusTitle: string; plusTitle: string }) {
  const m = Math.floor(value / 60);
  const s = (value % 60).toFixed(1).padStart(4, '0');
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="w-12 text-muted-foreground">{label}</span>
      <Button size="icon" variant="outline" className="size-7" title={minusTitle} onClick={onMinus}>
        <Minus className="size-3.5" />
      </Button>
      <span className="w-16 text-center font-mono">
        {m}:{s}
      </span>
      <Button size="icon" variant="outline" className="size-7" title={plusTitle} onClick={onPlus}>
        <Plus className="size-3.5" />
      </Button>
    </div>
  );
}

function Slider({ label, value, min, max, step, format, onChange }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="space-y-1 text-xs">
      <span className="flex justify-between text-muted-foreground">
        {label} <b className="font-mono text-foreground">{format(value)}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-primary" />
    </label>
  );
}

function TimeField({ value, onChange, onNow, onSeek }: { value: number; onChange: (v: number) => void; onNow: () => void; onSeek: () => void }) {
  return (
    <div className="space-y-1 text-xs">
      <span className="text-muted-foreground">Momento (s)</span>
      <div className="flex gap-1">
        <Input type="number" step={0.1} min={0} value={value} onChange={(e) => onChange(r1(Math.max(0, Number(e.target.value) || 0)))} className="h-8 text-xs" />
        <Button size="sm" variant="outline" className="h-8 px-2" title="Usar o momento em que o vídeo da prévia está pausado" onClick={onNow}>
          <Clock className="size-3.5" /> agora
        </Button>
        <Button size="icon" variant="ghost" className="size-8" title="Ir para este momento na prévia" onClick={onSeek}>
          <Play className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** Busca na biblioteca local pelo nome (memes/imagens ou sons). */
function AssetPicker({
  kinds,
  lib,
  onPick,
  onPreview,
  label,
}: {
  kinds: ('memes' | 'images' | 'audio')[];
  lib?: LibraryIndex;
  onPick: (kind: 'memes' | 'images' | 'audio', category: string, file: string) => void;
  onPreview?: (category: string, file: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    if (!lib) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const all = kinds.flatMap((kind) => lib[kind].flatMap((c) => c.files.map((file) => ({ kind, category: c.name, file, name: prettyAsset(file).toLowerCase() }))));
    return all.filter((a) => words.every((w) => a.name.includes(w) || a.category.toLowerCase().includes(w))).slice(0, 40);
  }, [lib, q, kinds]);
  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus /> {label}
      </Button>
    );
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4" onClick={() => setOpen(false)}>
      <div className="w-full max-w-md space-y-2 rounded-xl border bg-background p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Search className="size-4 text-muted-foreground" />
          <Input autoFocus placeholder="Buscar pelo nome (ex.: susto, risada, gato)" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button size="icon" variant="ghost" onClick={() => setOpen(false)}>
            <X />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Entra no momento em que a prévia está pausada; depois dá para ajustar.</p>
        <ul className="max-h-80 space-y-0.5 overflow-y-auto">
          {results.map((a) => (
            <li key={`${a.kind}/${a.category}/${a.file}`} className="flex items-center gap-1">
              <button
                className="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  onPick(a.kind, a.category, a.file);
                  setOpen(false);
                }}
              >
                {a.kind === 'audio' ? '🔊' : a.kind === 'images' ? '🖼️' : '🎬'} {prettyAsset(a.file)}
                <span className="ml-1 text-xs text-muted-foreground">{a.category !== '_geral' ? a.category : ''}</span>
              </button>
              {onPreview && (
                <Button size="icon" variant="ghost" className="size-7" title="Ouvir" onClick={() => onPreview(a.category, a.file)}>
                  <Play className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
          {!results.length && <li className="px-2 py-3 text-sm text-muted-foreground">{lib ? 'Nada encontrado.' : 'Carregando biblioteca…'}</li>}
        </ul>
      </div>
    </div>
  );
}

/** Quadros cobrindo exatamente o corte (o tamanho pode ter mudado depois de criados). */
function fitFrames(frames: ManualFrame[], total: number): ManualFrame[] {
  const list = [...frames].sort((a, b) => a.at - b.at).filter((f) => f.at < total - 0.2);
  if (!list.length) return [];
  list[0] = { ...list[0], at: 0 };
  for (let i = 0; i < list.length; i++) list[i] = { ...list[i], end: i + 1 < list.length ? list[i + 1].at : total };
  return list;
}
