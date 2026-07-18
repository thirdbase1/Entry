/** One-off admin diagnostic (2026-07-18): for every user in the DB, check github
 * Connect status directly (bypassing our own cached githubInstallationId) so we
 * can identify by externalSubject (github login) which account, if any, has a
 * completed user-subject grant. Bearer ADMIN_DEBUG_TOKEN only. Delete after use. */
import { prisma } from '@entry/db';
import { getTokenResponse } from '@vercel/connect';

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization') || '';
  const bearerOk = Boolean(process.env.ADMIN_DEBUG_TOKEN) && authHeader === `Bearer ${process.env.ADMIN_DEBUG_TOKEN}`;
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const users = await prisma.user.findMany({
    select: { id: true, email: true, createdAt: true, githubInstallationId: true },
    orderBy: { createdAt: 'desc' },
  });

  const results = [];
  for (const u of users) {
    const entry: Record<string, unknown> = { email: u.email, userId: u.id, cachedInstallationId: u.githubInstallationId };
    try {
      const resp = await getTokenResponse('github/entry-github', { subject: { type: 'user', id: u.id } });
      entry.connected = true;
      entry.externalSubject = resp.externalSubject;
      entry.installationId = resp.installationId;
      entry.tenantId = resp.tenantId;
    } catch (e: any) {
      entry.connected = false;
      entry.errorName = e?.name;
    }
    results.push(entry);
  }

  return Response.json({ results });
}
