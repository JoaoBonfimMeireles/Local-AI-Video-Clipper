import fs from 'node:fs';
import path from 'node:path';
import type { AssetRequest } from '@clipper/shared';
import { getJob } from '@clipper/shared/server';
import { badRequest } from '@/lib/validation';

export const dynamic = 'force-dynamic';

// Mesmos nomes do worker (apps/web/worker/recreate.ts): pedidos.json + pasta pedidos/<id>.<ext>
const ALLOWED = /\.(png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav|ogg|m4a|aac)$/i;
const MAX_BYTES = 200 * 1024 * 1024;

interface RequestsFile {
  concept: string;
  clips: { index: number; title: string; variant: string | null; requests: AssetRequest[] }[];
}

function load(id: string): { dir: string; data: RequestsFile } | null {
  const outputDir = getJob(id)?.result?.outputDir;
  const file = outputDir ? path.join(outputDir, 'pedidos.json') : null;
  if (!outputDir || !file || !fs.existsSync(file)) return null;
  return { dir: path.join(outputDir, 'pedidos'), data: JSON.parse(fs.readFileSync(file, 'utf8')) as RequestsFile };
}

const uploaded = (dir: string, reqId: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => path.parse(n).name === reqId) ?? null : null);

/** Pedidos de material de um job "a partir de corte viral" e quais já receberam arquivo. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = load(id);
  if (!r) return Response.json({ concept: '', clips: [] });
  return Response.json({
    concept: r.data.concept,
    clips: r.data.clips.map((c) => ({ ...c, requests: c.requests.map((q) => ({ ...q, uploaded: uploaded(r.dir, q.id) })) })),
  });
}

/** Recebe o arquivo de um pedido (form-data: requestId + file). Substitui o anterior, se houver. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const r = load(id);
    if (!r) return Response.json({ error: 'Este job não tem pedidos de material' }, { status: 404 });
    const form = await req.formData();
    const reqId = String(form.get('requestId') ?? '');
    const file = form.get('file');
    if (!r.data.clips.some((c) => c.requests.some((q) => q.id === reqId))) return badRequest(new Error('Pedido desconhecido'));
    if (!(file instanceof File) || !ALLOWED.test(file.name)) return badRequest(new Error('Envie uma imagem, GIF, vídeo curto ou áudio'));
    if (file.size > MAX_BYTES) return badRequest(new Error('Arquivo grande demais (máx. 200 MB)'));
    fs.mkdirSync(r.dir, { recursive: true });
    const old = uploaded(r.dir, reqId);
    if (old) fs.rmSync(path.join(r.dir, old), { force: true });
    const name = `${reqId}${path.extname(file.name).toLowerCase()}`;
    fs.writeFileSync(path.join(r.dir, name), Buffer.from(await file.arrayBuffer()));
    return Response.json({ ok: true, file: name });
  } catch (e) {
    return badRequest(e);
  }
}

/** Remove o arquivo de um pedido (?requestId=...). */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = load(id);
  const reqId = new URL(req.url).searchParams.get('requestId') ?? '';
  const old = r && /^[\w-]{1,40}$/.test(reqId) ? uploaded(r.dir, reqId) : null;
  if (r && old) fs.rmSync(path.join(r.dir, old), { force: true });
  return Response.json({ ok: !!old });
}
