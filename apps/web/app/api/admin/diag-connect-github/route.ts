/** One-off admin diagnostic (2026-07-18): check exactly what Connect sees for a
 * user's github grant right now -- isConnectAuthorized, raw getTokenResponse (or
 * the typed error it throws), and the most-recently-created/updated user by
 * email if no userId given. Bearer ADMIN_DEBUG_TOKEN only. Delete after use. */
import { prisma } from '@entry/db';
import { isConnectAuthorized, resolveGithubInstallationId } from '@entry/agent/lib/connect-service-tokens';
import { getTokenResponse } from '@vercel/connect';

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization') || '';
  const bearerOk = Boolean(process.env.ADMIN_DEBUG_TOKEN) && authHeader === `Bearer ${process.env.ADMIN_DEBUG_TOKEN}`;
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json()) as { userId?: string; email?: string; listUsers?: boolean };

  if (body.listUsers) {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, createdAt: true, githubInstallationId: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return Response.json({ users });
  }

  let { userId, email } = body;
  if (!userId) {
    const user = email
      ? await prisma.user.findFirst({ where: { email } })
      : await prisma.user.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!user) return Response.json({ error: 'No user found' }, { status: 404 });
    userId = user.id;
  }

  const result: Record<string, unknown> = { userId };

  try {
    result.isConnectAuthorized = await isConnectAuthorized(userId, 'github');
  } catch (e: any) {
    result.isConnectAuthorizedError = { name: e?.name, message: e?.message };
  }

  try {
    result.installationId = await resolveGithubInstallationId(userId);
  } catch (e: any) {
    result.resolveInstallationError = { name: e?.name, message: e?.message };
  }

  try {
    const tokenResponse = await getTokenResponse('github/entry-github', { subject: { type: 'user', id: userId } });
    result.tokenResponse = {
      connectorUid: tokenResponse.connector?.uid,
      tenantId: tokenResponse.tenantId,
      installationId: tokenResponse.installationId,
      externalSubject: tokenResponse.externalSubject,
      name: tokenResponse.name,
      expiresAt: tokenResponse.expiresAt,
    };
  } catch (e: any) {
    result.getTokenResponseError = { name: e?.name, message: e?.message, cause: e?.cause };
  }

  return Response.json(result);
}
