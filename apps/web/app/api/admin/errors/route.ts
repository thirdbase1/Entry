/**
 * Admin-only recent error viewer (2026-07-15) -- read-only window into the
 * error_logs table (see packages/db/src/error-log.ts + schema.prisma's
 * ErrorLog model) so a live "it's failing" report can be root-caused from
 * outside the sandbox (no local DATABASE_URL access to prod -- Neon's
 * Vercel integration doesn't expose it to `vercel env pull`, see
 * DEPLOY.md) without waiting on Vercel's own short-lived log tail.
 *
 * GET ?source=direct-chat-turn&limit=20 -- filters by source prefix
 * (optional) and limit (default 20, max 100).
 */
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export const GET = withApiErrorHandling(async (req: Request) => {
  // Either a real logged-in session (used from the browser) OR a bearer
  // token matching ADMIN_DEBUG_TOKEN (used for one-off out-of-band
  // debugging, e.g. via curl, when there's no browser session handy) --
  // single-owner product, so either one is fine.
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) {
    const { session } = await getUserSessionFromRequest(req);
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const source = url.searchParams.get('source');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);

  const logs = await prisma.errorLog.findMany({
    where: source ? { source: { contains: source } } : undefined,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return Response.json({ logs });
});
