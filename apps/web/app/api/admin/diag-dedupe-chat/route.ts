/** One-off admin diagnostic/fix (2026-07-23, real user report with
 * screenshot: the exact same assistant reply rendered twice in a row).
 * Root cause fixed going forward in persist-chat-events.ts +
 * direct/chat/route.ts (see those files' 2026-07-23 comments) -- this
 * route is ONLY for cleaning up chats that already have the duplicate
 * baked into their persisted `events` from BEFORE that fix shipped, so a
 * page reload stops re-showing stale corrupted history.
 *
 * Collapses any run of 2+ ADJACENT assistant messages whose `parts`
 * are byte-identical after stripping the volatile `state` field, keeping
 * just the LAST copy in the run (the one most likely to carry the real
 * messageMetadata/durationMs, since onFinish's final save always lands
 * after any earlier incremental duplicate). Bearer ADMIN_DEBUG_TOKEN
 * only.
 *
 * POST { chatId, dryRun?: boolean } -- dryRun (default true) reports
 * what WOULD change without writing; pass dryRun:false to actually fix.
 */
import { prisma } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

function partsSignature(parts: unknown): string {
  if (!Array.isArray(parts)) return JSON.stringify(parts);
  return JSON.stringify(
    parts.map((p: any) => {
      if (!p || typeof p !== 'object') return p;
      const { state, ...rest } = p;
      return rest;
    })
  );
}

export async function POST(req: Request) {
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { chatId, dryRun = true } = (await req.json()) as { chatId?: string; dryRun?: boolean };
  if (!chatId) return Response.json({ error: 'chatId required' }, { status: 400 });

  const row = await prisma.eveChatSession.findUnique({ where: { id: chatId }, select: { events: true, userId: true } });
  if (!row) return Response.json({ found: false });

  const events = Array.isArray(row.events) ? (row.events as any[]) : [];
  const result: any[] = [];
  const removedIndices: number[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const next = events[i + 1];
    if (
      ev?.role === 'assistant' &&
      next?.role === 'assistant' &&
      partsSignature(ev.parts) === partsSignature(next.parts)
    ) {
      // Drop THIS one, keep looking -- the loop's own next iteration
      // will re-compare `next` against whatever follows it, so a run of
      // 3+ identical copies collapses down to just the last one.
      removedIndices.push(i);
      continue;
    }
    result.push(ev);
  }

  if (!dryRun && removedIndices.length > 0) {
    await prisma.eveChatSession.update({ where: { id: chatId }, data: { events: result as any } });
  }

  return Response.json({
    chatId,
    dryRun,
    originalCount: events.length,
    finalCount: result.length,
    removedCount: removedIndices.length,
    removedIndices,
  });
}
