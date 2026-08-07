/**
 * Cheap, non-streaming "is this chat's turn still alive server-side?"
 * check -- used by direct-chat-interface.tsx's recovery poll so a
 * legitimately long-running silent tool call (a sandbox run, a
 * browser_use session) is never mistaken for "settled" just because
 * nothing new has landed in the DB recently. See the original
 * 2026-07-26 incident writeup preserved below; only the backing source
 * of truth changed (2026-08-07): a workflow run's own status IS this
 * signal now, no separate Redis heartbeat lock needed.
 *
 * `active: true` means "keep the UI locked/busy"; `active: false` means
 * the run genuinely finished (or never existed) -- both `completed` and
 * any terminal (`failed`/`cancelled`) status count as not-active, same
 * as a missing run.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getRun } from 'workflow/api';
import { resolveOwnedRunId } from '@/lib/direct-chat/resolve-active-run';

export async function GET(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { chatId } = await params;

  const runId = await resolveOwnedRunId(chatId, session.user.id);
  if (!runId) {
    return Response.json({ active: false }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const run = getRun(runId);
  if (!(await run.exists)) {
    return Response.json({ active: false }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const status = await run.status;
  return Response.json(
    { active: status === 'pending' || status === 'running' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
