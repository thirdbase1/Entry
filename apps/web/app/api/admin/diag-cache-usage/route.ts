/** One-off admin diagnostic (2026-07-23, user question: "does prompt
 * caching actually work or is it automatic" -- answering with real
 * production numbers instead of just reading the code). Lists the most
 * recent usage_events rows (any user) with their cache read/write token
 * counts, so it's possible to confirm directly whether Anthropic prompt
 * caching (see lib/direct-chat/prompt-cache.ts) is actually firing in
 * production, not just wired up in theory. Bearer ADMIN_DEBUG_TOKEN only,
 * read-only. */
import { prisma } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export async function POST(req: Request) {
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { limit } = (await req.json().catch(() => ({}))) as { limit?: number };

  const events = await prisma.usageEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit || 20,
    select: {
      createdAt: true,
      source: true,
      provider: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      cacheCreationTokens: true,
      cacheReadTokens: true,
    },
  });

  return Response.json({ events });
}
