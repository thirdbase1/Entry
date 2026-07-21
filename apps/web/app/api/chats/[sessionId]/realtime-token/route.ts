/**
 * Mints a short-lived, scoped Trigger.dev public access token for a
 * chat's currently-active background worker run (2026-07-21).
 *
 * Why a dedicated endpoint instead of returning the token alongside the
 * chat snapshot in GET /api/chats/[sessionId]: `auth.createPublicToken`
 * only makes sense to call while a background run is actually active
 * (backgroundRunId set), tokens are short-lived (20 min) by design so
 * they must be refetched periodically for a run that can chain up to 6
 * hours, and scoping to a single dedicated route keeps the Trigger.dev
 * secret key usage (TRIGGER_SECRET_KEY, server-only) contained to one
 * small, easy-to-audit file.
 *
 * Ownership check: same pattern as the sibling routes -- getChatSession
 * already scopes the row lookup to `session.user.id`, so a caller can
 * never mint a token for a run on someone else's chat.
 */
import { auth } from '@trigger.dev/sdk/v3';
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  if (!chat.backgroundRunActive || !chat.backgroundRunId) {
    // Not an error -- just means there's no active background run right
    // now (turn finished naturally within the sync route, or hasn't
    // started). The client treats this as "nothing to subscribe to."
    return Response.json({ runId: null, accessToken: null });
  }

  try {
    const accessToken = await auth.createPublicToken({
      scopes: { read: { runs: [chat.backgroundRunId] } },
      expirationTime: '20m',
    });
    return Response.json({ runId: chat.backgroundRunId, accessToken });
  } catch (err) {
    console.error('[realtime-token] failed to mint public access token', sessionId, err);
    return Response.json({ runId: null, accessToken: null });
  }
}
