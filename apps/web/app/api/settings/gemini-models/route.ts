import { listGeminiModels } from '@clipper/ai-providers';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json({ models: await listGeminiModels() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
