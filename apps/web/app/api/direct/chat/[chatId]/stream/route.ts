/**
 * Server side of the AI SDK's built-in resumable-stream reconnect
 * protocol (`useChat({ resume: true })` -> `resumeStream()` ->
 * `DefaultChatTransport.reconnectToStream`, confirmed directly against
 * node_modules/ai: it GETs exactly `{api}/{chatId}/stream`, expects a
 * 204 when there's nothing to resume, otherwise a normal UI-message-
 * stream body).
 *
 * ADDED (2026-07-25) alongside turn-lock.ts -- see that file's comment
 * for the full "reload / second tab / dropped connection should attach
 * to the STILL-LIVE turn instead of only finding out once it's fully
 * done" motivation. This replaces relying solely on DB polling for that
 * case: as long as the chat's turn lock is held, this endpoint replays
 * every chunk mirrored so far (Redis Stream, in order) and then tails
 * new ones live, in the EXACT wire format the original response used --
 * so a reconnecting `useChat` instance reconstructs the in-progress
 * assistant message the same way it would have if it had just stayed
 * connected the whole time.
 *
 * Deliberately does NOT touch Postgres at all -- purely a live-turn
 * concern. A chat with no active turn (the common case: most page loads
 * are not mid-turn) gets a cheap 204 here and the client's existing
 * history fetch + DB-backed recovery poll remain the source of truth for
 * everything that isn't a live in-flight turn.
 */
import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai';
import { getUserSessionFromRequest } from '@entry/auth';
import { prisma } from '@entry/db';
import { getActiveTurnId, readTurnStream } from '@/lib/direct-chat/turn-lock';

export async function GET(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { chatId } = await params;

  // Ownership check -- never let one user attach to another's live turn.
  const chat = await prisma.eveChatSession.findFirst({ where: { id: chatId, userId: session.user.id }, select: { id: true } });
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const activeTurnId = await getActiveTurnId(chatId);
  if (!activeTurnId) {
    // Matches reconnectToStream's own documented contract: 204 means
    // "nothing to resume", and the SDK treats that as a clean no-op.
    return new Response(null, { status: 204 });
  }

  const stream = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      try {
        for await (const { chunk } of readTurnStream(chatId, req.signal)) {
          controller.enqueue(chunk as UIMessageChunk);
        }
      } catch (err) {
        console.error('[direct chat stream] reattach failed', chatId, err);
        controller.error(err);
        return;
      }
      controller.close();
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: {
      'x-direct-chat-session-id': chatId,
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
