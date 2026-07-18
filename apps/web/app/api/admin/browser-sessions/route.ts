/**
 * One-off admin diagnostic (2026-07-17): the user reports "still failing,
 * all providers" for the "controlling model kept returning invalid
 * responses" error AFTER the plain-text JSON fallback + image-drop fix
 * shipped for decideSteelAction. Rather than re-guessing, this pulls the
 * real recent ChatBrowserSession rows (steel + brightdata lanes) straight
 * from the DB so we can see the actual `output`/`steps` from real runs --
 * whether they're pre- or post-deploy, which provider/model, and whether
 * the fallback path actually engaged (its own reason string differs from
 * the original bare "model did not return a valid next action").
 *
 * GET -- bearer ADMIN_DEBUG_TOKEN only, same pattern as admin/errors.
 */
import { prisma } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export async function GET(req: Request) {
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const sessions = await prisma.chatBrowserSession.findMany({
    where: { provider: { in: ['steel', 'brightdata'] } },
    orderBy: { updatedAt: 'desc' },
    take: 15,
  });

  return Response.json({
    sessions: sessions.map(s => ({
      id: s.id,
      chatId: s.chatId,
      provider: s.provider,
      status: s.status,
      task: s.task.slice(0, 150),
      output: s.output,
      isTaskSuccessful: s.isTaskSuccessful,
      stepCount: Array.isArray(s.steps) ? (s.steps as unknown[]).length : 0,
      lastSteps: Array.isArray(s.steps) ? (s.steps as unknown[]).slice(-5) : [],
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
    })),
  });
}
