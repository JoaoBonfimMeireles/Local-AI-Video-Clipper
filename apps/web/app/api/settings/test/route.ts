import { pingLLM } from '@clipper/ai-providers';
import { getAppSettings } from '@clipper/shared/server';

export const dynamic = 'force-dynamic';

export async function POST() {
  return Response.json(await pingLLM(getAppSettings()));
}
