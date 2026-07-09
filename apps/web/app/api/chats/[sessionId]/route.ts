/**
 * Single chat session: fetch a resumable snapshot (events + session cursor)
 * to feed useEveAgent's initialEvents/initialSession, save a fresh snapshot
 * (call from the client's onFinish), toggle favorite, toggle public sharing,
 * or delete.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession, removeChatSession, saveChatSnapshot, toggleChatCollected, setChatPublic } from '@entry/copilot';

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });
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
