/**
 * Cheap, non-streaming "is this chat's turn still alive server-side?"
 * check, backed by the same Redis turn-lock used by
 * `[chatId]/stream/route.ts` and `turn-lock.ts`.
 *
 * ADDED (2026-07-26, real user report: "I sent entry, it stops in 30s,
 * then after an hour I went back and it shows it worked for 16
 * minutes"). Root cause: direct-chat-interface.tsx's recovery poll used
 * to declare a turn "settled" (pendingTurn -> false, UI looks idle)
 * purely from a wall-clock heuristic -- `SETTLE_QUIET_MS` (4.5s) of no
 * new DB growth. That's correct for the 3s incremental-save throttle gap
 * it was originally written for, but completely wrong for a legitimately
 * long-running SILENT tool call (a sandbox run, a browser_use session, a
 * multi-minute search) which can go many minutes between saves while
 * still very much alive -- the poll gave up and showed "idle" long
 * before the real work was anywhere near done, even though nothing was
 * actually broken.
 *
 * This route is the authoritative fix: instead of guessing from timing,
 * the client now asks the ONE place that actually knows -- the same
 * Redis lock route.ts renews via `startTurnHeartbeat` for as long as the
 * turn's own async work is alive, completely independent of whether any
 * particular browser tab is still connected. `active: true` here means
 * "keep the UI locked/busy, no matter how long it's been quiet";
 * `active: false` is the only trustworthy "yes, it's actually done."
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { prisma } from '@entry/db';
import { getActiveTurnId } from '@/lib/direct-chat/turn-lock';

export async function GET(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { chatId } = await params;

  const chat = await prisma.eveChatSession.findFirst({ where: { id: chatId, userId: session.user.id }, select: { id: true } });
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const activeTurnId = await getActiveTurnId(chatId);
  return Response.json(
    { active: activeTurnId !== null },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
