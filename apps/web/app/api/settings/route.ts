import { z } from 'zod';
import { getAppSettings, getEnvValue, saveAppSettings, SECRET_KEYS, writeEnvValues } from '@clipper/shared/server';
import { AppSettingsSchema, badRequest, SecretsSchema } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/** Nunca devolve o valor das chaves — só se estão configuradas. */
function secretsStatus() {
  return Object.fromEntries(SECRET_KEYS.map((k) => [k, !!getEnvValue(k)]));
}

export async function GET() {
  return Response.json({ settings: getAppSettings(), secrets: secretsStatus() });
}

export async function PUT(req: Request) {
  try {
    const body = z.object({ settings: AppSettingsSchema.optional(), secrets: SecretsSchema.optional() }).parse(await req.json());
    if (body.settings) saveAppSettings(body.settings);
    if (body.secrets) writeEnvValues(body.secrets);
    return Response.json({ settings: getAppSettings(), secrets: secretsStatus() });
  } catch (e) {
    return badRequest(e);
  }
}
