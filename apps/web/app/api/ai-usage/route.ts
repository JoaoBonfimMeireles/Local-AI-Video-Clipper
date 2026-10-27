import { getAiUsageSince } from '@clipper/shared/server';

export const dynamic = 'force-dynamic';

/** Uso de IA de hoje (desde a meia-noite local) e dos últimos 7 dias, somando todos os jobs. */
export async function GET() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const week = new Date(Date.now() - 7 * 24 * 3600_000);
  return Response.json({ today: getAiUsageSince(midnight.toISOString()), week: getAiUsageSince(week.toISOString()) });
}
