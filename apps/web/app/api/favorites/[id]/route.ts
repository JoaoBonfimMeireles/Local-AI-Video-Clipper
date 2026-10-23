import fs from 'node:fs';
import { dataPaths, deleteFavorite, getFavorite, isInside } from '@clipper/shared/server';

export const dynamic = 'force-dynamic';

/** Remove dos favoritos (e apaga a cópia guardada). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fav = getFavorite(id);
  if (!fav) return Response.json({ error: 'Favorito não encontrado' }, { status: 404 });
  deleteFavorite(id);
  if (isInside(dataPaths.favorites, fav.dir) && fav.dir !== dataPaths.favorites) {
    try {
      fs.rmSync(fav.dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* arquivo em uso (player aberto): fica para trás, sem registro */
    }
  }
  return Response.json({ ok: true });
}
