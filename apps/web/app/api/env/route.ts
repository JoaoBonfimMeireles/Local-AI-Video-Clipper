import path from 'node:path';
import { getRepoRoot, runProcess } from '@clipper/shared/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const root = getRepoRoot();
  const res = await runProcess(process.execPath, [path.join(root, 'scripts', 'check-env.js'), '--json'], { cwd: root, timeoutMs: 60_000 });
  try {
    return Response.json(JSON.parse(res.stdout));
  } catch {
    return Response.json({ ok: false, checks: [], error: res.stderrTail }, { status: 500 });
  }
}
