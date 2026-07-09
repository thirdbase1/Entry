/**
 * Chat session list (sidebar/library) + create-on-first-send.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { createChatSession, listChatSessions } from '@entry/copilot';

export async function GET(req: Request) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const sessions = await listChatSessions(session.user.id);
  return Response.json({ sessions });
}

export async function POST(req: Request) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { sessionId, title, docId } = body ?? {};
  if (!sessionId) return Response.json({ error: 'sessionId is required' }, { status: 400 });

  const chat = await createChatSession(session.user.id, sessionId, { title, docId });
  return Response.json(chat, { status: 201 });
}
