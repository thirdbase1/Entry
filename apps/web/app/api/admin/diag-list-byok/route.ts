/** One-off admin diagnostic: list a user's BYOK connections + their models (id, provider, model, status) so we can
 * pick a different one for stress-testing without exposing secrets. Bearer ADMIN_DEBUG_TOKEN only. */
import { prisma } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export async function POST(req: Request) {
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId } = (await req.json()) as { userId?: string };
  if (!userId) return Response.json({ error: 'userId required' }, { status: 400 });

  const providers = await prisma.userModelProvider.findMany({
    where: { userId },
    select: {
      id: true,
      label: true,
      compatibility: true,
      baseUrl: true,
      lastError: true,
      models: {
        select: { id: true, modelId: true, label: true, isEnabled: true, lastTestStatus: true, lastTestedAt: true, lastTestError: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  return Response.json({ providers });
}
