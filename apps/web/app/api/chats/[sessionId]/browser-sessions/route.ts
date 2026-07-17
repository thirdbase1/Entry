/**
 * Backs the chat page's "Browser" tab (chat-browser-tab.tsx) -- explicit
 * user request: "the UI should actually display the live browser and I'm
 * seeing what it's doing realtime... the agent should be able to stop
 * the browser and start... make sure the browser displays well in the
 * UI." Works identically for both direct/BYOK and eve-default chats
 * (unlike the Files/Preview tabs) since browser_use.ts/browser_stop.ts
 * are shared tool-impls used by both paths.
 *
 * GET lists every ChatBrowserSession row for this chat (most recent
 * first, so the panel can render live iframes immediately) -- the DB row
 * (and its liveUrl) is written by browser_use.ts the moment a session is
 * created, well before that tool call itself finishes, so this reflects
 * a live browser as soon as it exists, independent of whether the
 * agent's tool call has returned yet.
 *
 * POST { session_id } stops a session manually -- lets the user kill a
 * live browser themselves from the panel, not just the agent via
 * browser_stop.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';
import { prisma } from '@entry/db';
import { stopBrowserUseSession, type BrowserUseSlot } from '@entry/agent/lib/browser-use-cloud-client';
import { stopSteelSession } from '@entry/agent/lib/steel-client';

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const rows = await prisma.chatBrowserSession.findMany({
    where: { chatId: sessionId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  return Response.json({
    sessions: rows.map(r => ({
      id: r.id,
      provider: r.provider,
      slot: r.slot,
      task: r.task,
      status: r.status,
      liveUrl: r.liveUrl,
      output: r.output,
      isTaskSuccessful: r.isTaskSuccessful,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const browserSessionId = typeof body.session_id === 'string' ? body.session_id : null;
  if (!browserSessionId) return Response.json({ error: 'session_id is required' }, { status: 400 });

  const row = await prisma.chatBrowserSession.findUnique({ where: { id: browserSessionId } });
  if (!row || row.chatId !== sessionId) return Response.json({ error: 'Not found' }, { status: 404 });

  if (row.status !== 'stopped') {
    try {
      if (row.provider === 'steel') {
        await stopSteelSession(row.providerSessionId);
      } else {
        await stopBrowserUseSession(row.slot as BrowserUseSlot, row.providerSessionId);
      }
    } catch {
      // Same reasoning as browser_stop.ts: a provider-side stop failure
      // (already idle/expired) shouldn't block freeing up the slot.
    }
    await prisma.chatBrowserSession.update({ where: { id: row.id }, data: { status: 'stopped' } });
  }

  return Response.json({ stopped: true });
}
