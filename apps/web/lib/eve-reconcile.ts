/**
 * Server-side reconciliation for chats whose persisted snapshot looks like
 * a turn that never got to finish persisting.
 *
 * ROOT CAUSE (2026-07-11, reported: "if agent is working and I reload page
 * this nonsense show and I don't see the agent reply at all again"):
 * `saveChatSnapshot` (see chats.ts) is ONLY ever called from ONE place --
 * the ORIGINAL browser tab's `useEveAgent({ onFinish })` callback in
 * chat-interface.tsx. eve's own session/turn state lives on ITS side
 * (apps/agent, mounted into this same app via withEve -- same origin,
 * same process, not a separate always-on service the browser happens to
 * poll), and genuinely keeps running server-side independent of any
 * browser tab. But nothing else ever wrote a finished turn back to
 * Postgres -- if the tab that started the turn reloads or closes before
 * `onFinish` fires, that finished reply is stuck in eve's own session
 * state forever as far as THIS app's database is concerned. A reload
 * lands on the stale "user message, no reply yet" row and polls a
 * database row nothing was ever going to update again -- the exact
 * infinite "Still working…" banner reported.
 *
 * Fix: reattach directly to eve's own session truth using its public
 * `Client`/`ClientSession` API (confirmed in node_modules/eve/dist/src/
 * client/session.d.ts: `stream()` resumes from the session's stored
 * cursor, independent of which caller asks -- it's a real reattachment,
 * not tied to the browser tab that started the turn) instead of relying
 * solely on a browser tab's `onFinish` having run. Bounded by
 * `maxWaitMs` so a genuinely still-in-progress turn doesn't hold this
 * request open indefinitely -- returns whatever new events arrived
 * within that window; the caller persists them, and the next scheduled
 * client poll (chat-interface.tsx's 3s `tryRecover`) calls this again
 * and picks up further progress, converging on the full transcript over
 * a few cycles the same way the original tab would have seen it stream
 * in live.
 */
import { Client } from 'eve/client';
import type { HandleMessageStreamEvent, SessionState } from 'eve/client';

/** Stream event types that mean the turn (or session) has reached a real
 *  resting state -- no more progress is coming without a brand-new
 *  `send()`. Anything else as the LAST persisted event means a turn was
 *  left mid-flight the last time anything wrote to the database. */
const TERMINAL_EVENT_TYPES = new Set([
  'turn.completed',
  'turn.failed',
  'session.completed',
  'session.failed',
  'input.requested',
  'authorization.required',
  'session.waiting',
]);

export function looksLikePendingTurn(events: unknown): boolean {
  if (!Array.isArray(events) || events.length === 0) return false;
  const last = events[events.length - 1] as { type?: string } | undefined;
  if (!last || typeof last.type !== 'string') return false;
  return !TERMINAL_EVENT_TYPES.has(last.type);
}

export async function reconcileEveSession(
  origin: string,
  cursor: unknown,
  existingEvents: unknown
): Promise<{ events: HandleMessageStreamEvent[]; cursor: SessionState } | null> {
  const state = cursor as SessionState | null | undefined;
  if (!state?.sessionId) return null;

  const client = new Client({ host: origin });
  const session = client.session(state);
  const collected: HandleMessageStreamEvent[] = [];
  const maxWaitMs = 8000;
  const deadline = Date.now() + maxWaitMs;

  try {
    for await (const event of session.stream()) {
      collected.push(event);
      if (Date.now() > deadline) break;
    }
  } catch {
    // Best-effort only -- a genuinely dead/expired eve session, or a
    // transient hiccup reaching our own same-origin /eve/v1/* routes,
    // just means "nothing new to report this poll"; the caller keeps
    // whatever was already persisted and this gets tried again on the
    // next scheduled poll.
  }

  if (collected.length === 0) return null;

  const base = Array.isArray(existingEvents) ? (existingEvents as HandleMessageStreamEvent[]) : [];
  return { events: [...base, ...collected], cursor: session.state };
}
