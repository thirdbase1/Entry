/**
 * Server side of the AI SDK's resumable-stream reconnect protocol.
 *
 * MIGRATED (2026-08-07) off the Redis turn-lock/mirror (turn-lock.ts,
 * now retired) onto @ai-sdk/workflow's WorkflowChatTransport contract --
 * see turn-workflow.ts's file header for the full migration rationale.
 * The URL segment here (still named `[chatId]` for route-file continuity)
 * receives TWO different id shapes depending on which of the transport's
 * own code paths is calling it (confirmed directly against
 * node_modules/@ai-sdk/workflow/src/workflow-chat-transport.ts):
 *   - the chat's real chatId, from the PUBLIC `reconnectToStream()` entry
 *     point (the "resume: true on mount" / page-refresh path) -- this is
 *     the one direct-chat-interface.tsx actually drives, via
 *     `resume: !!activeWorkflowRunId` same as the library's own
 *     documented pattern.
 *   - the raw workflow run id, from the transport's OWN internal
 *     mid-`sendMessages()` retry loop (a network blip during a send that
 *     hasn't finished yet, still within the same tab) -- extracted by the
 *     transport itself from this route's sibling POST response's
 *     `x-workflow-run-id` header.
 * resolveOwnedRunId handles both shapes uniformly and -- critically --
 * NEVER trusts a bare run id from the URL without first confirming it
 * belongs to a chat row this exact user owns.
 *
 * No manual 204-vs-200 contract to get right anymore either: the
 * transport only ever calls this when it already believes a live/replay-
 * able run exists (constructor's own docs: pair `resume` with a stored
 * run id), so this just resolves the run and streams it -- a genuinely
 * missing/expired run is the one real 204 case left.
 */
import { createUIMessageStreamResponse } from 'ai';
import { getRun } from 'workflow/api';
import { getUserSessionFromRequest } from '@entry/auth';
import { resolveOwnedRunId } from '@/lib/direct-chat/resolve-active-run';

export async function GET(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { chatId: rawParam } = await params;

  const url = new URL(req.url);
  const startIndexRaw = parseInt(url.searchParams.get('startIndex') ?? '0', 10);
  const startIndex = Number.isFinite(startIndexRaw) ? startIndexRaw : 0;

  const runId = await resolveOwnedRunId(rawParam, session.user.id);
  if (!runId) {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }

  const run = getRun(runId);
  if (!(await run.exists)) {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }

  const readable = run.getReadable({ startIndex });

  return createUIMessageStreamResponse({
    stream: readable,
    headers: {
      'x-workflow-run-id': runId,
      'x-direct-chat-session-id': rawParam,
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
