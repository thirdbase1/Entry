/**
 * REAL server-side turn cancellation (added 2026-08-08, live bug report:
 * "stop button doesn't work to stop agent"). Root cause: the stop button
 * in direct-chat-interface.tsx was only ever wired to `chat.stop()`, the
 * AI SDK's built-in stop -- which for a WorkflowChatTransport just aborts
 * THIS TAB's own fetch/reader. It does not touch the durable workflow run
 * at all, and by design (see turn-workflow.ts's file header) that run
 * keeps executing on Vercel's own infra independent of any client
 * connection -- that's the whole point of the migration to durable
 * workflows. The side effect nobody wired up: there was no path left for
 * the user to actually kill a turn they no longer want running, since
 * closing the tab was already a no-op for it. This endpoint gives the
 * "stop" affordance a real server-side action: cancel the workflow run
 * itself via the Workflow SDK's own `Run.cancel()`, so the agent process,
 * its tool calls, and its token spend actually stop.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getRun } from 'workflow/api';
import { prisma } from '@entry/db';
import { resolveOwnedRunId } from '@/lib/direct-chat/resolve-active-run';

export async function POST(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { chatId } = await params;
  const userId = session.user.id;

  // Flip the cooperative stop flag FIRST, before anything that could
  // throw -- this is what turn-workflow.ts's heartbeat loop actually
  // polls to abort an in-flight leg within ~5s (see its own comment).
  // `run.cancel()` below additionally stops the orchestrator from ever
  // scheduling a next leg, but does nothing for a leg already streaming.
  const row = await prisma.eveChatSession.findFirst({ where: { id: chatId, userId }, select: { cursor: true } });
  const existingCursor = row?.cursor && typeof row.cursor === 'object' ? (row.cursor as Record<string, unknown>) : {};
  await prisma.eveChatSession
    .update({ where: { id: chatId, userId }, data: { cursor: { ...existingCursor, stopRequested: true } } })
    .catch(err => console.error('[direct chat stop] failed to set stopRequested flag', chatId, err));

  const runId = await resolveOwnedRunId(chatId, userId);
  if (!runId) {
    // Nothing to cancel -- either already finished or never existed.
    // Not an error from the caller's point of view: "stop" on an already
    // -stopped turn should read as success, not a scary failure toast.
    return Response.json({ stopped: false, reason: 'no_active_run' }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const run = getRun(runId);
  try {
    if (!(await run.exists)) {
      return Response.json({ stopped: false, reason: 'run_not_found' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const status = await run.status;
    if (status !== 'pending' && status !== 'running') {
      // Already terminal (completed/failed/cancelled) -- nothing left to stop.
      return Response.json({ stopped: false, reason: 'already_terminal', status }, { headers: { 'Cache-Control': 'no-store' } });
    }
    await run.cancel();
    return Response.json({ stopped: true, runId }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[direct chat stop] failed to cancel workflow run', chatId, runId, err);
    return Response.json({ error: 'Failed to stop the turn. It may already be finishing.' }, { status: 500 });
  }
}
