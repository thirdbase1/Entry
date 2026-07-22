/**
 * Single chat session: fetch a resumable snapshot (events + session cursor,
 * or plain messages[] for direct-chat rows -- see EveChatSession's schema
 * comment) to feed the chat UI's initial state, save a fresh snapshot,
 * toggle favorite, toggle public sharing, or delete.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession, removeChatSession, saveChatSnapshot, toggleChatCollected, setChatPublic } from '@entry/copilot';

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  // RETIRED (2026-07-22): this used to self-heal an eve turn left
  // mid-flight by reattaching to eve's own live session state (see
  // former lib/eve-reconcile.ts). eve is fully decommissioned now --
  // every row is a direct-chat row, whose equivalent "stuck turn"
  // recovery already happens client-side (direct-chat-interface.tsx's
  // own recovery poll re-fetches this same route), so no server-side
  // reconciliation is needed here anymore.
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
