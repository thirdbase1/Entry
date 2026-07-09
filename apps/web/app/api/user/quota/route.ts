/**
 * Replaces core/quota/resolver.ts's `QuotaResolver.getQuota` (a GraphQL
 * `@ResolveField` on `UserType.quota`) — exposed here as its own REST
 * endpoint under `/api/user/quota`, resolved against the current session
 * instead of a GraphQL field resolver's `@CurrentUser()` param.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { quota } from '@entry/features';

export async function GET(req: Request) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const userQuota = await quota.getUserQuotaWithUsage(session.user.id);
  return Response.json({ ...userQuota, humanReadable: quota.formatUserQuota(userQuota) });
}
