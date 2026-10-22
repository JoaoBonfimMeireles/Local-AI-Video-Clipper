import { dataPaths, scanLibrary } from '@clipper/shared/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ library: scanLibrary(), dirs: { memes: dataPaths.memes, audio: dataPaths.audio, images: dataPaths.images } });
}
