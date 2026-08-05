/**
 * Admin-only GitHub connection inspector/fixer (2026-07-29) -- lets an
 * out-of-band debug session (no local DATABASE_URL access to prod, see
 * errors/route.ts's own header for why) check exactly what a specific
 * user's GitHub state really is (our DB's githubInstallationId + whether
 * a vault credential exists) and, if it's stale, clear it -- same
 * bearer-token-or-session auth pattern as /api/admin/errors.
 *
 * GET  ?email=x@y.com            -- read-only status
 * POST { "email": "x@y.com", "clearInstallationId": true }
 *   -- clears githubInstallationId (never touches the vault credential;
 *      use /api/admin/users to remove the user entirely if needed)
 */
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';
import { listCredentials } from '@entry/agent/lib/credential-vault';

async function requireAdmin(req: Request) {
  if (isAdminBearerAuthorized(req)) return true;
  const { session } = await getUserSessionFromRequest(req);
  return !!session;
}

export const GET = withApiErrorHandling(async (req: Request) => {
  if (!(await requireAdmin(req))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const email = url.searchParams.get('email');
  const id = url.searchParams.get('id');
  if (!email && !id) return Response.json({ error: 'Pass ?email= or ?id=' }, { status: 400 });

  const user = await prisma.user.findFirst({
    where: id ? { id } : { email: email! },
    select: { id: true, email: true, githubInstallationId: true },
  });
  if (!user) return Response.json({ error: 'User not found' }, { status: 404 });

  const credentials = await listCredentials(user.id).catch(() => []);
  const hasGithubToken = credentials.some((c: { service: string }) => c.service === 'github');

  return Response.json({
    id: user.id,
    email: user.email,
    githubInstallationId: user.githubInstallationId,
    hasGithubToken,
  });
});

export const POST = withApiErrorHandling(async (req: Request) => {
  if (!(await requireAdmin(req))) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json()) as { email?: string; id?: string; clearInstallationId?: boolean };
  if (!body.email && !body.id) return Response.json({ error: 'Pass email or id' }, { status: 400 });

  const user = await prisma.user.findFirst({
    where: body.id ? { id: body.id } : { email: body.email! },
    select: { id: true },
  });
  if (!user) return Response.json({ error: 'User not found' }, { status: 404 });

  if (body.clearInstallationId) {
    await prisma.user.update({ where: { id: user.id }, data: { githubInstallationId: null } });
  }

  return Response.json({ success: true });
});
