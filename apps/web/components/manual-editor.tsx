'use client';
// Edição manual de um corte pronto: ajusta à mão o que a IA decidiu (trechos, rosto/enquadramento, zooms,
// memes e sons) e manda renderizar de novo — sem chamar a IA no plano.
import { useEffect, useMemo, useState } from 'react';
import { Clock, Loader2, Minus, Play, Plus, Search, Trash2, X } from 'lucide-react';
import { DEFAULT_MANUAL_TEXT, type Clip, type FrameBox, type LibraryIndex, type ManualEdit, type ManualFrame, type ManualLogo, type ManualText, type MemeBrand } from '@clipper/shared';
import { AlignPad, defaultFrames, FramingEditor, LivePreview, useClipPlayer, type PreviewOverlay } from '@/components/manual-preview';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api, fileUrl, uploadMemeAsset } from '@/lib/client';
import { cn } from '@/lib/utils';

type Overlay = ManualEdit['overlays'][number];
type Sfx = ManualEdit['sfx'][number];

interface ClipMeta {
  duration: number;
  format?: string;
  resolution?: string;
  edit?: { shots?: any[]; zooms?: any[]; overlays?: any[]; sfx?: any[]; frames?: ManualFrame[] | null; texts?: ManualText[] | null; logo?: ManualLogo | null; background?: string | null };
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
const r2 = (n: number) => Math.round(n * 100) / 100;

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
    zooms: (e.zooms ?? []).map((z) => ({ at: z.at, duration: z.duration, scale: z.scale, focusX: z.focusX ?? 0.5, focusY: z.focusY ?? 0.4, ...(z.target === 'cam' ? { target: 'cam' as const } : {}) })),
    overlays: (e.overlays ?? []).map((o) => ({ type: o.type === 'image' ? 'image' : 'meme', category: o.category ?? '_geral', file: o.file, at: o.at, duration: o.duration, position: o.position ?? 'top', scale: o.scale ?? 0.5, audioMode: o.audioMode ?? 'both' })),
    sfx: (e.sfx ?? []).map((x) => ({ category: x.category ?? '_geral', file: x.file, at: x.at, volume: x.volume ?? 0.8, duration: x.duration })),
    camZoom: 1,
    texts: e.texts ?? [],
    background: e.background ?? null,
    logo: e.logo ?? null,
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
    // Logo do canal: a mesma do Editor de vídeo
    api<{ brand: MemeBrand }>('/api/memes')
      .then((r) => setBrandLogo(r.brand.logoStill && r.brand.logoStillFile ? r.brand.logoStillFile : r.brand.logo))
      .catch(() => setBrandLogo(null));
  }, [clip.metadataPath]);
  const [brandLogo, setBrandLogo] = useState<string | null | undefined>(undefined);
  const [logoUp, setLogoUp] = useState<number | null>(null);
  /** Põe esta imagem como logo (mantém lugar e tamanho se já havia uma). */
  const setLogo = (file: string) => update((d) => ({ ...d, logo: { x: 0.85, y: 0.06, size: 0.07, ...d.logo, file } }));
  /** Logo enviada aqui vai para data/meme-studio/assets (a mesma pasta das imagens do Editor de vídeo). */
  async function onLogoFile(f: File | undefined) {
    if (!f) return;
    setLogoUp(0);
    try {
      setLogo((await uploadMemeAsset(f, setLogoUp)).path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLogoUp(null);
    }
  }

  const segments = useMemo(() => draft?.segments ?? [], [draft?.segments]);
  // Vídeo da prévia: o original ou uma cópia leve (VOD em MPEG-TS não toca no navegador)
  const [source, setSource] = useState<{ path: string; offset: number; original?: string } | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  useEffect(() => {
    api<{ path: string; offset: number; original?: string }>(`/api/jobs/${clip.jobId}/clips/${clip.index}/preview-source`).then(setSource).catch((e) => setSourceError((e as Error).message));
  }, [clip.jobId, clip.index]);
  const player = useClipPlayer(segments, source?.offset ?? 0, !!source);
  // "Outra cena" ao lado precisa do original inteiro: o próprio arquivo (se toca) ou uma cópia leve dele (só quando usado)
  const hasScene = !!draft?.frames?.some((f) => f.sideTop?.kind === 'scene' || f.sideBottom?.kind === 'scene');
  const [sceneUrl, setSceneUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!hasScene || sceneUrl || !source) return;
    if (source.offset === 0 && source.path === source.original) return setSceneUrl(fileUrl(source.path));
    if (!source.original) return;
    const name = source.original.split(/[\/]/).pop()!;
    api<{ path: string }>(`/api/inputs/preview?name=${encodeURIComponent(name)}`)
      .then((r) => setSceneUrl(fileUrl(r.path)))
      .catch(() => undefined);
  }, [hasScene, sceneUrl, source]);
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
        d.texts = d.texts?.map((x) => ({ ...x, at: x.at === undefined ? undefined : mv({ at: x.at }).at, end: x.end === undefined ? undefined : mv({ at: x.end }).at }));
        // Enquadramentos também: as trocas depois do começo deste trecho andam junto
        if (d.frames) {
          const mvT = (t: number) => (t > offset + 0.001 ? Math.max(offset, Math.round((t + shift) * 100) / 100) : t);
          d.frames = d.frames.map((f) => ({ ...f, at: mvT(f.at), end: mvT(f.end) }));
        }
      }
      // Os enquadramentos sempre cobrem o corte inteiro: o tempo ganho no começo/fim entra no vizinho e pode ser editado
      if (d.frames?.length) d.frames = fitFrames(d.frames, d.segments.reduce((a, s) => a + (s.end - s.start), 0));
      return d;
    });
  }

  /** Apaga o trecho [a, b) do corte (tempo do corte): os trechos do original perdem esse pedaço e tudo depois anda junto. */
  function cutRange(a: number, b: number) {
    if (!draft) return;
    const len = b - a;
    const pieces: ManualEdit['segments'] = [];
    let off = 0;
    for (const sg of draft.segments) {
      const L = sg.end - sg.start;
      if (a > off) pieces.push({ ...sg, end: r2(sg.start + Math.min(L, a - off)) });
      if (b < off + L) pieces.push({ ...sg, start: r2(sg.start + Math.max(0, b - off)) });
      off += L;
    }
    // Pedaços colados no original viram um só; pedaços muito curtos (< 0,5 s) o render ignoraria
    const segs = pieces
      .filter((sg) => sg.end - sg.start >= 0.5)
      .reduce<ManualEdit['segments']>((acc, sg) => {
        const last = acc[acc.length - 1];
        if (last && Math.abs(last.end - sg.start) < 0.01) last.end = sg.end;
        else acc.push({ ...sg });
        return acc;
      }, []);
    if (!segs.length) return setError('Não dá para apagar o corte inteiro.');
    if (segs.length > 8) return setError('O corte pode ter no máximo 8 trechos; junte ou tire algum antes de apagar mais.');
    setError(null);
    const map = (t: number) => r2(t <= a ? t : t < b ? a : t - len);
    const mv = <T extends { at: number }>(x: T) => ({ ...x, at: map(x.at) });
    update((d) => {
      d.segments = segs;
      const total = segs.reduce((acc, sg) => acc + (sg.end - sg.start), 0);
      d.overlays = d.overlays.map(mv);
      d.sfx = d.sfx.map(mv);
      d.zooms = d.zooms.map(mv);
      d.shots = d.shots.map(mv);
      d.texts = d.texts
        ?.map((x) => ({ ...x, at: x.at === undefined ? undefined : map(x.at), end: x.end === undefined ? undefined : map(x.end) }))
        .filter((x) => x.at === undefined || x.end === undefined || x.end - x.at >= 0.2);
      if (d.frames?.length) d.frames = fitFrames(d.frames.map((f) => ({ ...f, at: map(f.at), end: map(f.end) })).filter((f) => f.end - f.at >= 0.05), total);
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
  const previewLogo = useMemo(() => (draft?.logo ? { url: fileUrl(draft.logo.file), x: draft.logo.x, y: draft.logo.y, size: draft.logo.size } : null), [draft?.logo]);
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
                <LivePreview
                  player={player}
                  frames={draft.frames}
                  zooms={draft.zooms}
                  overlays={previewOverlays}
                  sfx={previewSfx}
                  W={W}
                  H={H}
                  sceneUrl={sceneUrl}
                  texts={draft.texts}
                  logo={previewLogo}
                  background={draft.background}
                  onMoveText={(i, x, y) => update((d) => (d.texts && Object.assign(d.texts[i], { x, y }), d))}
                  onMoveLogo={(x, y) => update((d) => (d.logo && Object.assign(d.logo, { x, y }), d))}
                />
              ) : (
                <div className="grid aspect-[9/16] w-full max-w-[300px] place-items-center rounded-lg bg-black p-4 text-center text-xs text-muted-foreground">
                  <span>
                    <Loader2 className="mx-auto mb-2 animate-spin" />
                    {source ? 'Carregando o vídeo…' : 'Preparando a prévia (só na primeira vez, pode levar 1 minuto)…'}
                  </span>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                A prévia mostra <b>na hora</b> o enquadramento, os zooms, os memes, os textos, a logo e os sons (legendas e placar só aparecem no vídeo final). Arraste um texto ou a logo na prévia para mudar o lugar. Pause onde quiser e use <Clock className="inline size-3" />{' '}
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
                    toOriginal={(t) => player.toSource(t) + (source?.offset ?? 0)}
                    onChange={(frames) => {
                      setFramesTouched(true);
                      update((d) => ({ ...d, frames }));
                    }}
                    onCut={cutRange}
                    background={draft.background}
                    enhancePreview={(box) =>
                      api(`/api/jobs/${clip.jobId}/clips/${clip.index}/enhance-preview`, { method: 'POST', body: JSON.stringify({ at: player.toSource(player.now()) + (source?.offset ?? 0), box }) })
                    }
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">Carregando o vídeo original…</p>
                )}
              </Section>

              <Section title="Fundo" hint="O que aparece nas sobras quando o vídeo está em “Inteiro” (não muda nada nas partes em “Preencher”).">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {(
                    [
                      [null, 'Desfocado'],
                      ['#ffffff', 'Branco'],
                      ['#000000', 'Preto'],
                    ] as const
                  ).map(([c, label]) => (
                    <Button key={label} size="sm" variant={(draft.background ?? null) === c ? 'default' : 'outline'} onClick={() => update((d) => ({ ...d, background: c }))}>
                      {c && <span className="size-3 rounded-full border" style={{ background: c }} />} {label}
                    </Button>
                  ))}
                  <label className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">Outra cor</span>
                    <input type="color" value={draft.background ?? '#ffffff'} onChange={(e) => update((d) => ({ ...d, background: e.target.value }))} className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent" />
                  </label>
                </div>
              </Section>

              <Section
                title="Textos"
                hint="Texto por cima do vídeo. Escolha topo, meio ou embaixo, ou arraste o texto na prévia. Enter quebra a linha."
                action={
                  <Button size="sm" variant="outline" onClick={() => update((d) => ({ ...d, texts: [...(d.texts ?? []), { ...DEFAULT_MANUAL_TEXT }] }))}>
                    <Plus /> Adicionar texto
                  </Button>
                }
              >
                {(draft.texts ?? []).map((tx, i) => (
                  <TextRow
                    key={i}
                    value={tx}
                    total={total}
                    now={now}
                    seek={seek}
                    onChange={(v) => update((d) => ((d.texts![i] = v), d))}
                    onRemove={() => update((d) => ((d.texts = d.texts!.filter((_, j) => j !== i)), d))}
                  />
                ))}
                {draft.texts?.length ? (
                  <Button size="sm" variant="outline" onClick={() => update((d) => ({ ...d, texts: [...(d.texts ?? []), { ...DEFAULT_MANUAL_TEXT, y: 0.5 }] }))}>
                    <Plus /> Adicionar outro texto
                  </Button>
                ) : (
                  <Empty>Nenhum texto.</Empty>
                )}
              </Section>

              <Section title="Logo" hint="Qualquer imagem (PNG com fundo transparente fica melhor), o corte todo. Arraste na prévia para mudar o lugar.">
                <div className="space-y-2 rounded-lg border p-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {draft.logo ? (
                      <img src={fileUrl(draft.logo.file)} alt="logo" className="h-10 max-w-24 rounded bg-black/40 object-contain p-0.5" />
                    ) : (
                      <span className="grid h-10 w-16 place-items-center rounded border border-dashed text-[10px] text-muted-foreground">sem logo</span>
                    )}
                    <label className={cn('inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border px-3 hover:bg-accent', logoUp !== null && 'pointer-events-none opacity-60')}>
                      <Plus className="size-3.5" /> {logoUp !== null ? `Enviando ${Math.round(logoUp * 100)}%` : draft.logo ? 'Trocar por outra imagem' : 'Enviar uma logo'}
                      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => onLogoFile(e.target.files?.[0])} />
                    </label>
                    {brandLogo && draft.logo?.file !== brandLogo && (
                      <Button size="sm" variant="outline" onClick={() => setLogo(brandLogo)}>
                        Usar a logo do canal
                      </Button>
                    )}
                    {draft.logo && (
                      <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => update((d) => ({ ...d, logo: null }))}>
                        <Trash2 className="size-3.5" /> Tirar a logo
                      </Button>
                    )}
                  </div>
                  {draft.logo && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1 text-xs">
                        <span className="text-muted-foreground">Posição</span>
                        <AlignPad value={{ x: draft.logo.x, y: draft.logo.y }} onChange={(a) => update((d) => (d.logo && Object.assign(d.logo, a), d))} tall />
                        <div className="flex flex-wrap gap-1">
                          {LOGO_SPOTS.map((p) => (
                            <Button key={p.label} size="sm" variant="outline" className="h-7 px-2" onClick={() => update((d) => (d.logo && Object.assign(d.logo, { x: p.x, y: p.y }), d))}>
                              {p.label}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <Slider label="Tamanho" value={draft.logo.size} min={0.03} max={0.25} step={0.005} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update((d) => (d.logo && (d.logo.size = v), d))} />
                    </div>
                  )}
                </div>
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
                hint="“Só a câmera” põe a câmera (a caixa de cima do enquadramento) na tela toda durante o zoom, sem o resto."
                action={
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => update((d) => ({ ...d, zooms: [...d.zooms, { at: now(), duration: 2, scale: 1.2, focusX: 0.5, focusY: 0.4 }].sort((a, b) => a.at - b.at) }))}>
                      <Plus /> Zoom agora
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => update((d) => ({ ...d, zooms: [...d.zooms, { at: now(), duration: 2, scale: 1, focusX: 0.5, focusY: 0.4, target: 'cam' as const }].sort((a, b) => a.at - b.at) }))}>
                      <Plus /> Zoom na câmera
                    </Button>
                  </div>
                }
              >
                {draft.zooms.map((z, i) => (
                  <Row key={i} title={z.target === 'cam' ? '🎥 Só a câmera' : '🔍 Tela toda'} onRemove={() => update((d) => ((d.zooms = d.zooms.filter((_, j) => j !== i)), d))}>
                    <TimeField value={z.at} onChange={(v) => update((d) => ((d.zooms[i].at = v), d))} onNow={() => update((d) => ((d.zooms[i].at = now()), d))} onSeek={() => seek(z.at)} />
                    <label className="space-y-1 text-xs">
                      <span className="text-muted-foreground">O que aproxima</span>
                      <Select
                        className="h-8 text-xs"
                        value={z.target ?? 'screen'}
                        onChange={(e) => update((d) => ((d.zooms[i] = e.target.value === 'cam' ? { ...d.zooms[i], target: 'cam', scale: Math.max(1, d.zooms[i].scale) } : { ...d.zooms[i], target: undefined, scale: Math.max(1.05, d.zooms[i].scale) }), d))}
                      >
                        <option value="screen">Tela toda</option>
                        <option value="cam">Só a câmera (tela cheia)</option>
                      </Select>
                    </label>
                    <Slider label={z.target === 'cam' ? 'Aproximar o rosto' : 'Força'} value={z.scale} min={z.target === 'cam' ? 1 : 1.05} max={2} step={0.05} format={(v) => `${v.toFixed(2)}x`} onChange={(v) => update((d) => ((d.zooms[i].scale = v), d))} />
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

const LOGO_SPOTS = [
  { label: '↖ Canto de cima', x: 0.15, y: 0.06 },
  { label: 'Topo', x: 0.5, y: 0.06 },
  { label: 'Canto de cima ↗', x: 0.85, y: 0.06 },
  { label: '↙ Canto de baixo', x: 0.15, y: 0.94 },
  { label: 'Canto de baixo ↘', x: 0.85, y: 0.94 },
];

const TEXT_SPOTS = [
  { label: 'Topo', y: 0.12 },
  { label: 'Meio', y: 0.5 },
  { label: 'Embaixo', y: 0.85 },
];

/** Um texto: conteúdo, lugar, estilo (cor, tamanho, borda, caixa) e quando aparece. */
function TextRow({ value: tx, total, now, seek, onChange, onRemove }: { value: ManualText; total: number; now: () => number; seek: (t: number) => void; onChange: (v: ManualText) => void; onRemove: () => void }) {
  const set = (patch: Partial<ManualText>) => onChange({ ...tx, ...patch });
  const whole = tx.at === undefined && tx.end === undefined;
  return (
    <div className="space-y-2 rounded-lg border p-2.5 text-xs">
      <div className="flex items-start gap-1">
        <textarea value={tx.text} rows={Math.min(4, Math.max(1, tx.text.split('\n').length))} onChange={(e) => set({ text: e.target.value })} placeholder="Escreva o texto" className="min-h-8 flex-1 resize-y rounded-md border bg-background px-2 py-1.5 text-sm" />
        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" title="Remover" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <AlignPad value={{ x: tx.x, y: tx.y }} onChange={(a) => set(a)} tall />
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">Lugar:</span>
            {TEXT_SPOTS.map((p) => (
              <Button key={p.label} size="sm" variant={Math.abs(tx.y - p.y) < 0.01 && Math.abs(tx.x - 0.5) < 0.01 ? 'default' : 'outline'} className="h-7 px-2" onClick={() => set({ x: 0.5, y: p.y })}>
                {p.label}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground">Arraste o ponto (para cima, para baixo, para os lados) ou o próprio texto na prévia.</p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <Slider label="Tamanho" value={tx.size} min={0.03} max={0.15} step={0.005} format={(v) => `${Math.round(v * 1000) / 10}`} onChange={(v) => set({ size: v })} />
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Cor do texto</span>
          <input type="color" value={tx.color} onChange={(e) => set({ color: e.target.value })} className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent" />
        </label>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Slider label="Borda" value={tx.outline} min={0} max={0.25} step={0.01} format={(v) => (v ? `${Math.round(v * 100)}%` : 'sem')} onChange={(v) => set({ outline: v })} />
          </div>
          <input type="color" title="Cor da borda" value={tx.outlineColor} onChange={(e) => set({ outlineColor: e.target.value })} className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={tx.box} onChange={(e) => set({ box: e.target.checked })} className="accent-primary" />
          Caixa atrás do texto
        </label>
        {tx.box && (
          <>
            <input type="color" title="Cor da caixa" value={tx.boxColor} onChange={(e) => set({ boxColor: e.target.value })} className="h-7 w-9 cursor-pointer rounded border-0 bg-transparent" />
            <div className="w-40">
              <Slider label="Opacidade" value={tx.boxOpacity} min={0.1} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ boxOpacity: v })} />
            </div>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex items-center gap-1.5 pb-2">
          <input
            type="checkbox"
            checked={whole}
            onChange={(e) => (e.target.checked ? set({ at: undefined, end: undefined }) : set({ at: now(), end: r1(Math.min(total, now() + 3)) }))}
            className="accent-primary"
          />
          O corte inteiro
        </label>
        {!whole && (
          <>
            <div className="w-56">
              <TimeField label="De (s)" value={tx.at ?? 0} onChange={(v) => set({ at: v })} onNow={() => set({ at: now() })} onSeek={() => seek(tx.at ?? 0)} />
            </div>
            <div className="w-56">
              <TimeField label="Até (s)" value={tx.end ?? total} onChange={(v) => set({ end: v })} onNow={() => set({ end: now() })} onSeek={() => seek(tx.end ?? total)} />
            </div>
          </>
        )}
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

function TimeField({ value, onChange, onNow, onSeek, label = 'Momento (s)' }: { value: number; onChange: (v: number) => void; onNow: () => void; onSeek: () => void; label?: string }) {
  return (
    <div className="space-y-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
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
