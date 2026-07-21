/** One-off admin diagnostic (2026-07-21): confirm the REAL live value of a
 * given env var name at runtime (length + first/last few chars only, never
 * the full secret) -- `vercel env pull` cannot reveal "Sensitive"-type env
 * vars even when correctly set, so this is the only way to confirm what
 * the running deployment actually received. Bearer ADMIN_DEBUG_TOKEN only. */
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export async function POST(req: Request) {
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { name } = (await req.json()) as { name?: string };
  if (!name) return Response.json({ error: 'name required' }, { status: 400 });
  const val = process.env[name];
  return Response.json({
    present: val !== undefined,
    length: val?.length ?? 0,
    prefix: val ? val.slice(0, 8) : null,
    suffix: val ? val.slice(-4) : null,
  });
}
