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
import { getActiveTurnId, readTurnStream, hasTurnStreamEnded } from '@/lib/direct-chat/turn-lock';

export async function GET(req: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { chatId } = await params;

  // Ownership check -- never let one user attach to another's live turn.
  const chat = await prisma.eveChatSession.findFirst({ where: { id: chatId, userId: session.user.id }, select: { id: true } });
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const activeTurnId = await getActiveTurnId(chatId);
  // TERMINAL-REPLAY FIX (2026-07-27) -- see hasTurnStreamEnded's own
  // comment in turn-lock.ts. A stale-but-not-yet-expired lock can still
  // report `activeTurnId` truthy well after this exact turn already
  // delivered its end marker once; without this check we'd still open a
  // stream below and let readTurnStream's own internal guard handle it,
  // which is safe but wasteful (a full extra round trip and Redis
  // connection for something already known to be over) -- short-circuit
  // to the same clean 204 contract here instead, right at the door.
  if (activeTurnId && hasTurnStreamEnded(chatId, activeTurnId)) {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!activeTurnId) {
    // Matches reconnectToStream's own documented contract: 204 means
    // "nothing to resume", and the SDK treats that as a clean no-op.
    //
    // FIXED (2026-07-25, real production crash: "TypeError: Response
    // with null body status cannot have body" thrown INSIDE the
    // browser's own fetch() while reconnectToStream() GETs this exact
    // URL -- confirmed via error_logs, client-error-boundary,
    // chatId pNoDkjoDqK9Ild5D). That error only exists because a 204 is
    // one of the Fetch spec's "null body status" codes -- ANY response
    // claiming status 204 must have zero bytes, no exceptions. This
    // branch's Response body genuinely is null, so the bug wasn't here in
    // the handler itself -- it's that this route had NO Cache-Control
    // header at all on this specific 204, unlike the streaming branch
    // below which explicitly sets one. Cloudflare sits in front of this
    // exact origin (entry.pxxl.pro) and this URL is a plain GET with no
    // caching directive, so on a reconnect race (turn ends between the
    // client's initial request and a retried/duplicate one) the edge is
    // free to cache this bodyless 204 and later replay it ALONGSIDE
    // whatever bytes a *different*, later, real 200 streaming response to
    // the identical URL left sitting in a shared connection/cache slot --
    // producing exactly the "204 status + non-empty body" wire-level
    // contradiction the browser's fetch() correctly refuses to parse.
    // `no-store` closes that off completely: this route is 100%
    // per-request dynamic (a live Redis turn stream), so it must never be
    // cached, cached-and-revalidated, or reused across requests by ANY
    // intermediary, full stop.
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }

  const stream = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      try {
        for await (const { chunk } of readTurnStream(chatId, req.signal)) {
          controller.enqueue(chunk as UIMessageChunk);
        }
      } catch (err) {
        console.error('[direct chat stream] reattach failed', chatId, err);
        try { controller.error(err); } catch {}
        return;
      }
      try { controller.close(); } catch {}
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: {
      'x-direct-chat-session-id': chatId,
      // Strengthened from 'no-cache' to 'no-store' alongside the 204
      // branch's fix above -- see that comment. 'no-cache' still permits
      // a shared cache to store the response and revalidate it later;
      // 'no-store' forbids storing it anywhere, which is what a live,
      // never-repeatable turn stream actually needs.
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
