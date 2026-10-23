// Layout de um corte a partir das áreas que o editor marcou no painel (câmera do streamer e conteúdo do react).
// Com "acompanhar", a área marcada é o ponto de partida e a detecção local ajusta se a pessoa/o player mudar de lugar.
import { detectCamBox, detectPlayerBox, type DetectedFace } from '@clipper/ai-providers';
import type { ClipLayout } from '@clipper/editing-planner';
import type { FrameBox, ManualLayout } from '@clipper/shared';

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const area = (b: FrameBox) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
/** Caixa aumentada em `f` (fração do próprio tamanho) para cada lado, dentro do quadro. */
const grow = (b: FrameBox, f: number): FrameBox => {
  const dx = (b.x1 - b.x0) * f;
  const dy = (b.y1 - b.y0) * f;
  return { x0: clamp01(b.x0 - dx), y0: clamp01(b.y0 - dy), x1: clamp01(b.x1 + dx), y1: clamp01(b.y1 + dy) };
};
const inter = (a: FrameBox, b: FrameBox): FrameBox => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

/** Move a caixa (mesmo tamanho) para onde o rosto está neste corte, se ele for achado perto da área marcada. */
function followFace(box: FrameBox, frames: { faces: DetectedFace[] }[]): { box: FrameBox; moved: boolean } {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  // Procura numa janela 60% maior que a área marcada; em cada frame, o rosto mais perto do centro
  const near = frames
    .map((f) => f.faces.filter((x) => Math.abs(x.x - cx) <= w * 0.8 && Math.abs(x.y - cy) <= h * 0.8).sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0])
    .filter((x): x is DetectedFace => !!x);
  if (near.length < frames.length * 0.3) return { box, moved: false };
  const med = (k: 'x' | 'y') => near.map((x) => x[k]).sort((a, b) => a - b)[Math.floor(near.length / 2)];
  // Deslocamento do rosto em relação à posição do rosto quando a área foi marcada (assume rosto no centro)
  const dx = med('x') - cx;
  const dy = med('y') - cy;
  if (Math.abs(dx) < w * 0.08 && Math.abs(dy) < h * 0.08) return { box, moved: false };
  const x0 = clamp01(Math.min(1 - w, box.x0 + dx));
  const y0 = clamp01(Math.min(1 - h, box.y0 + dy));
  return { box: { x0, y0, x1: x0 + w, y1: y0 + h }, moved: true };
}

export async function manualClipLayout(
  m: ManualLayout,
  frames: { path: string; faces: DetectedFace[]; time?: number }[],
  signal?: AbortSignal,
): Promise<{ layout: ClipLayout; note: string }> {
  const paths = frames.map((f) => f.path);
  const notes: string[] = [];
  let cam: FrameBox | null = null;
  let bubble: FrameBox | null = null;
  if (m.cam) {
    let box = m.cam.box;
    if (m.cam.track) {
      const f = followFace(box, frames);
      box = f.box;
      if (f.moved) notes.push('câmera acompanhou o rosto');
    }
    if (m.cam.shape === 'circle' && m.cam.mode === 'bubble') {
      bubble = box;
      notes.push('rosto em círculo no canto');
    } else if (m.cam.shape === 'circle') {
      // Círculo no rosto → expande até o quadradinho da câmera em volta dele
      const face = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, w: (box.x1 - box.x0) * 0.7, h: (box.y1 - box.y0) * 0.7 };
      const exact = await detectCamBox(paths, face, signal);
      if (exact && face.x > exact.box.x0 && face.x < exact.box.x1 && face.y > exact.box.y0 && face.y < exact.box.y1) {
        cam = exact.box;
        notes.push('câmera expandida a partir do rosto');
      } else {
        // Sem moldura: câmera 16:9 com o rosto ocupando ~25% da largura
        const cw = Math.min(1, face.w * 4);
        // Em fração do quadro, uma câmera 16:9 num vídeo 16:9 tem a mesma fração de largura e altura
        const ch = cw;
        const x0 = clamp01(Math.min(1 - cw, face.x - cw / 2));
        const y0 = clamp01(Math.min(1 - ch, face.y - ch * 0.42));
        cam = { x0, y0, x1: x0 + cw, y1: y0 + ch };
        notes.push('câmera estimada pelo rosto');
      }
    } else {
      cam = box;
    }
  }
  let content: FrameBox | null = null;
  if (m.content) {
    content = m.content.box;
    if (m.content.track) {
      // A câmera (ou o rosto do modo círculo, com folga) fica fora da busca: o streamer se mexendo não é o player
      const camArea = cam ?? (bubble ? grow(bubble, 0.6) : null);
      const p = await detectPlayerBox(paths, camArea, signal);
      // Só troca se o player achado estiver quase todo dentro da área marcada (com uma folga de 15%)
      if (p && area(inter(p.box, grow(content, 0.15))) >= 0.8 * area(p.box) && area(p.box) >= 0.35 * area(content)) {
        content = p.box;
        notes.push('conteúdo encaixado no player');
      }
    }
  }
  // Conteúdo dinâmico: em janelas de ~4s, vê se o conteúdo saiu do quadradinho e tomou a tela (o streamer pôs o
  // vídeo em tela cheia, abriu outra janela...). Nesses trechos o enquadramento passa para a área nova.
  let contentPhases: { at: number; end: number; box: FrameBox }[] = [];
  if (m.content?.track && content) {
    const camArea = cam ?? (bubble ? grow(bubble, 0.6) : null);
    contentPhases = await detectContentPhases(frames, content, camArea, signal);
    if (contentPhases.length) notes.push(`conteúdo em tela cheia em ${contentPhases.map((p) => `${p.at.toFixed(0)}–${p.end.toFixed(0)}s`).join(', ')}`);
  }
  return { layout: { cam, gameplay: !cam, content, bubble, contentPhases }, note: notes.join(', ') };
}

/** Janelas do corte em que o conteúdo ficou bem maior que a área marcada (tela cheia), já agrupadas. */
async function detectContentPhases(
  frames: { path: string; time?: number }[],
  marked: FrameBox,
  camArea: FrameBox | null,
  signal?: AbortSignal,
): Promise<{ at: number; end: number; box: FrameBox }[]> {
  const WIN = 4;
  const timed = frames.map((f, i) => ({ ...f, t: f.time ?? i }));
  if (timed.length < 8) return [];
  const last = timed[timed.length - 1].t;
  const wins: { at: number; end: number; box: FrameBox | null }[] = [];
  for (let at = 0; at <= last; at += WIN) {
    const inWin = timed.filter((f) => f.t >= at && f.t < at + WIN);
    if (inWin.length < 3) continue;
    const p = await detectPlayerBox(inWin.map((f) => f.path), camArea, signal);
    // "Tela cheia": a região que se mexe cresceu bem além da área marcada (≥1,3x maior e ≥30% dela fora da marcação)
    const big = !!p && area(p.box) >= 1.3 * area(marked) && area(p.box) - area(inter(p.box, marked)) >= 0.3 * area(p.box);
    wins.push({ at, end: Math.min(last + 1, at + WIN), box: big ? p!.box : null });
  }
  // Agrupa janelas seguidas de tela cheia; trechos de uma janela só (≈4s) são ignorados (troca rápida demais)
  const phases: { at: number; end: number; box: FrameBox }[] = [];
  for (let i = 0; i < wins.length; i++) {
    if (!wins[i].box) continue;
    let j = i;
    while (j + 1 < wins.length && wins[j + 1].box) j++;
    if (j > i) {
      const boxes = wins.slice(i, j + 1).map((w) => w.box!);
      // Caixa que cobre o conteúdo nas janelas do grupo (mediana de cada borda)
      const med = (k: keyof FrameBox) => boxes.map((b) => b[k]).sort((a, b) => a - b)[Math.floor(boxes.length / 2)];
      phases.push({ at: wins[i].at, end: wins[j].end, box: { x0: med('x0'), y0: med('y0'), x1: med('x1'), y1: med('y1') } });
    }
    i = j;
  }
  return phases;
}
