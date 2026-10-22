import { z } from 'zod';
import { listPresets, savePreset } from '@clipper/shared/server';
import { badRequest, JobSettingsSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ presets: listPresets() });
}

export async function POST(req: Request) {
  try {
    const body = z.object({ name: z.string().trim().min(1).max(80), settings: JobSettingsSchema }).parse(await req.json());
    return Response.json({ preset: savePreset(body.name, body.settings) }, { status: 201 });
  } catch (e) {
    return badRequest(e);
  }
}
