/**
 * Single chat session: fetch a resumable snapshot (events + session cursor)
 * to feed useEveAgent's initialEvents/initialSession, save a fresh snapshot
 * (call from the client's onFinish), toggle favorite, toggle public sharing,
 * or delete.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession, removeChatSession, saveChatSnapshot, toggleChatCollected, setChatPublic } from '@entry/copilot';
import { looksLikePendingTurn, reconcileEveSession } from '@/lib/eve-reconcile';

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  // Self-heal a turn that was left mid-flight because the tab that
  // started it never got to persist the finished reply (see
  // eve-reconcile.ts's file comment for the full root cause). Guarded by
  // both the cheap "does the last event even look unfinished" check AND
  // a 15-minute inactivity cutoff -- a genuinely abandoned/expired
  // session shouldn't pay an 8s live reattachment cost on every single
  // 3s client poll forever.
  const staleEnoughToRetry = Date.now() - new Date(chat.updatedAt).getTime() < 15 * 60 * 1000;
  if (staleEnoughToRetry && looksLikePendingTurn(chat.events)) {
    const origin = new URL(req.url).origin;
    const reconciled = await reconcileEveSession(origin, chat.cursor, chat.events).catch(() => null);
    if (reconciled) {
      await saveChatSnapshot(session.user.id, sessionId, { events: reconciled.events, cursor: reconciled.cursor }).catch(() => {});
      return Response.json({ ...chat, events: reconciled.events, cursor: reconciled.cursor });
    }
  }

  return Response.json(chat);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const body = await req.json().catch(() => ({}));

  if (body?.toggleCollected) {
    const chat = await toggleChatCollected(session.user.id, sessionId);
    return Response.json(chat);
  }

  if (typeof body?.setPublic === 'boolean') {
    const share = await setChatPublic(session.user.id, sessionId, body.setPublic);
    return Response.json(share);
  }

  const { events, cursor, title } = body ?? {};
  await saveChatSnapshot(session.user.id, sessionId, { events, cursor, title });
  return Response.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const ok = await removeChatSession(session.user.id, sessionId);
  return Response.json({ ok });
}
