/** One-off admin diagnostic (2026-07-21): list a user's most recent chat
 * sessions (id, title, event count, byok/gateway model, timestamps) to
 * verify whether recent turns actually persisted. Bearer ADMIN_DEBUG_TOKEN
 * only, read-only. */
import { prisma } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export async function POST(req: Request) {
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId, limit } = (await req.json()) as { userId?: string; limit?: number };
  if (!userId) return Response.json({ error: 'userId required' }, { status: 400 });

  const chats = await prisma.eveChatSession.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: limit || 15,
    select: {
      id: true,
      title: true,
      byokModelId: true,
      requestedModel: true,
      createdAt: true,
      updatedAt: true,
      events: true,
    },
  });

  return Response.json({
    chats: chats.map(c => ({
      id: c.id,
      title: c.title,
      byokModelId: c.byokModelId,
      requestedModel: c.requestedModel,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      eventCount: Array.isArray(c.events) ? c.events.length : 0,
    })),
  });
}
