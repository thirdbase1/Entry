/**
 * Race-safe persistence for `eve_chat_sessions.events` (2026-07-23, real
 * user-confirmed bug: "some chat disappear also some model response
 * disappeared forever" -- reproduced by reading, not logs, since nothing
 * ever threw: both writes below succeed individually by design).
 *
 * ROOT CAUSE: direct/chat/route.ts's preSave (on an existing row) and its
 * onFinish final-save each did a plain, unconditional
 * `update({ data: { events: <in-memory array captured at THIS request's
 * OWN start> } })` -- a classic last-write-wins overwrite of the ENTIRE
 * column, not an append. `events` here is always "whatever this one
 * request's own snapshot was, plus what this one request itself
 * produced" -- it never re-reads the row's actual current state before
 * writing. Any two requests touching the same chatId close enough
 * together (a double-submit, two tabs/devices open on the same chat, or
 * simply a user who got impatient during a long tool-heavy turn -- now
 * legitimately up to 10 minutes, see bash.ts/agent.ts's own timeout
 * comments -- and re-sent while the first turn was still genuinely
 * running) race: whichever one's `update` commits LAST completely
 * clobbers the other's already-durably-saved turn, silently. No
 * exception anywhere, nothing for error_logs to catch -- exactly why
 * `vercel logs`/Render logs showed nothing for this.
 *
 * FIX: every write now happens inside a single transaction that (1) takes
 * a row lock (`SELECT ... FOR UPDATE`) so no second writer can read the
 * row while this one is mid-write, (2) reads `events` fresh, and (3) only
 * replaces it with this request's own reconstructed array when nothing
 * newer has been committed since this request's own baseline snapshot --
 * otherwise it appends this request's own new delta (whatever it added
 * beyond its own baseline) onto the ACTUAL current row instead of
 * regressing it. A normal, non-overlapping turn behaves identically to
 * before (current DB state IS this request's own baseline, so the
 * "replace" branch fires and produces the exact same result); only the
 * genuinely-overlapping case now merges instead of destroying data.
 *
 * FIXED (2026-07-23, real user-reported bug with screenshot: the exact
 * same assistant reply rendered TWICE in a row, no second timer under
 * the repeat). Root cause: direct/chat/route.ts calls this function
 * MULTIPLE times per turn from the SAME request -- once per `onStepEnd`
 * (a multi-step turn: a tool call step, then a final text step, fires
 * this at each step boundary) and once more from `onFinish` at the very
 * end -- and every one of those calls passed the SAME static
 * request-start `uiMessages` as `baseMessages`, never updated to reflect
 * this request's OWN prior incremental saves. So by this function's own
 * "has something newer landed since baseMessages?" logic, its own
 * step-1 save (which grew `currentEvents` past the static baseline)
 * looked EXACTLY like a legitimate concurrent write from a different
 * request -- the step-2 save (and then onFinish's final save) each took
 * the "append delta on top of current" branch instead of "replace",
 * stacking a fresh copy of the still-growing assistant message on top of
 * the previous incremental copy every single time, once per extra
 * step/finish call past the first. A 2-step turn (one tool call + one
 * final answer) reliably produced exactly the 2 visible duplicate copies
 * from the report; a longer tool-chain turn would have produced more.
 *
 * Fix: this now returns the array it ACTUALLY persisted (`merged`, not
 * just the whole-column update fire-and-forget it used to be) so a
 * caller making several calls in the same request can feed each
 * function's own real, current baseline into the NEXT call instead of
 * reusing one static request-start snapshot -- see route.ts's
 * `persistedBaseline` variable, updated after every call site. The
 * genuine concurrent-write race this function exists to protect against
 * is completely unaffected: a real second request's own commit still
 * shows up as `currentEvents.length > baseMessages.length` from this
 * (now correctly up-to-date) baseline's point of view, so the merge
 * branch still fires exactly when it's supposed to.
 */
import { prisma } from '@entry/db';

/**
 * BUG FIX (owner report 2026-07-26, screen recording: the FIRST message
 * of a chat -- an old, already-finished assistant reply -- suddenly
 * repeating itself dozens of times in a row, growing over ~30s, during a
 * later tool-heavy turn ("delegate 20 sub agents"). Root cause: this
 * file's own `runMergeTransaction` decides "did a concurrent writer add
 * something newer?" purely by comparing ARRAY LENGTH
 * (`currentEvents.length > baseMessages.length`) -- a heuristic that
 * silently breaks the moment more than one thing can plausibly touch the
 * same row's `events` column around the same top-level message count
 * (a long multi-step agentic turn firing many onStepFinish saves in
 * quick succession is exactly that scenario). When the heuristic
 * mis-fires, `merged = [...currentEvents, ...delta]` can re-stitch
 * ALREADY-PRESENT messages back onto the array a second (or twentieth)
 * time. Rather than trying to make the length heuristic perfectly race-
 * proof (fragile by construction), dedupe by message `id` right before
 * every write -- and again on every read in chats.ts's getChatSession --
 * as the actual structural guarantee: no matter what upstream race
 * produced a duplicate, the persisted (and therefore rendered) array can
 * never contain the same message id twice. Keeps the LAST occurrence of
 * a given id (parts only ever grow across incremental saves of the same
 * in-progress message, so the later copy is always the more complete
 * one).
 */
function messageCompleteness(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const message = value as { parts?: unknown[] };
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const textLength = parts.reduce<number>((sum, part) => {
    if (!part || typeof part !== 'object') return sum;
    const text = (part as { text?: unknown }).text;
    return sum + (typeof text === 'string' ? text.length : 0);
  }, 0);
  return parts.length * 1_000_000 + textLength * 10 + JSON.stringify(value).length;
}

/**
 * Merge snapshots without ever deleting a message or regressing a message's
 * streamed content. This is used inside the row-locked write transaction,
 * so a stale request can only add its own newer messages/progress to the
 * current row; it cannot replace the row with an older transcript.
 */
export function mergeMessagesAppendOnly(current: unknown[], incoming: unknown[]): unknown[] {
  const incomingById = new Map<string, unknown>();
  for (const message of incoming) {
    const id = (message as { id?: unknown } | null)?.id;
    if (typeof id === 'string') incomingById.set(id, message);
  }
  const merged = current.map(message => {
    const id = (message as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return message;
    const next = incomingById.get(id);
    if (next === undefined) return message;
    return messageCompleteness(next) >= messageCompleteness(message) ? next : message;
  });
  const currentIds = new Set(
    current.map(message => (message as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === 'string'),
  );
  for (const message of incoming) {
    const id = (message as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !currentIds.has(id)) merged.push(message);
  }
  return merged;
}

export function dedupeMessagesById(events: unknown[]): unknown[] {
  const lastIndexById = new Map<string, number>();
  events.forEach((ev, i) => {
    const id = (ev as { id?: unknown } | null)?.id;
    if (typeof id === 'string') lastIndexById.set(id, i);
  });
  const out: unknown[] = [];
  const seen = new Set<string>();
  events.forEach((ev, i) => {
    const id = (ev as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') {
      out.push(ev);
      return;
    }
    if (seen.has(id)) return; // an earlier occurrence of this id -- skip, the later one (kept below) wins
    seen.add(id);
    out.push(i === lastIndexById.get(id) ? ev : events[lastIndexById.get(id)!]);
  });
  return out;
}


/**
 * @param chatId       The chat session id.
 * @param userId       Owning user id (never trust a chatId alone).
 * @param baseMessages The message array THIS request started from (its
 *                      own snapshot of "history so far" before it added
 *                      anything of its own) -- or, for a second/third call
 *                      within the SAME request (e.g. a later onStepEnd,
 *                      or the final onFinish), the array this SAME
 *                      request's own most recent prior call to this
 *                      function actually persisted (this function's own
 *                      return value) -- never the original static
 *                      request-start snapshot again, or every later call
 *                      will misread its own earlier save as a foreign
 *                      concurrent write and duplicate on top of it.
 * @param newMessages  The full reconstructed array this request wants to
 *                      persist -- baseMessages plus whatever this request
 *                      itself just added (a new user turn, a new
 *                      assistant reply, or both).
 * @param extraFields  Any other columns to set in the same update
 *                      (byokModelId/requestedModel on preSave's path).
 * @returns The array actually written to the row's `events` column --
 *          feed this straight back in as the next call's `baseMessages`.
 */
async function runMergeTransaction(
  chatId: string,
  userId: string,
  baseMessages: unknown[],
  newMessages: unknown[],
  extraFields: Record<string, unknown>,
): Promise<unknown[]> {
  // Widened maxWait/timeout (2026-07-24, real user-confirmed bug found
  // live in Render's logs: "Transaction API error: Unable to start a
  // transaction in the given time" firing repeatedly during a real
  // 4-minute tool-heavy turn). Prisma's own defaults here are maxWait:
  // 2000ms (time allowed to even ACQUIRE a connection from the pool
  // before starting) and timeout: 5000ms (time allowed for the whole
  // transaction body to run) -- both are tuned for a low-latency local
  // Postgres, not a hosted pooled connection (this app's DATABASE_URL
  // points at Neon's `-pooler` PgBouncer endpoint) under any real
  // concurrent load. A transient multi-second stall acquiring a
  // connection is a normal, recoverable blip on a shared pooled
  // endpoint -- it should never be treated the same as a truly hung
  // transaction. Widening buys real breathing room without masking a
  // genuinely stuck query (10s is still far short of anything a human
  // would sit and wait on).
  return prisma.$transaction(
    async tx => {
      const rows = await tx.$queryRaw<{ events: unknown }[]>`
        SELECT events FROM eve_chat_sessions WHERE id = ${chatId} AND user_id = ${userId} FOR UPDATE
      `;
      const currentEvents = Array.isArray(rows[0]?.events) ? (rows[0]!.events as unknown[]) : [];

      // Nothing newer landed since our own baseline -> this request's own
      // reconstruction is already correct and complete, write it as-is
      // (identical to the old behavior for the common, non-overlapping case).
      // Something newer DID land (another turn committed while we were
      // running) -> the current row is the authoritative base now; append
      // only OUR delta on top of it instead of clobbering that newer state.
      // Always merge by message id and completeness. The old length-based
      // branch could treat a stale snapshot as authoritative and overwrite
      // a longer reply, especially during a reload or concurrent save.
      const merged = dedupeMessagesById(mergeMessagesAppendOnly(currentEvents, newMessages));

      await tx.eveChatSession.update({
        where: { id: chatId, userId },
        data: { events: merged as any, ...extraFields },
      });

      return merged;
    },
    { maxWait: 8_000, timeout: 10_000 },
  );
}

/**
 * Only retries errors that are genuinely transient DB/pool contention --
 * never retries a real application error (e.g. a constraint violation, a
 * bad query), which would just repeat the same failure 3x for no benefit
 * and delay surfacing a real bug.
 */
function isTransientDbError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /unable to start a transaction/i.test(message) ||
    /transaction api error/i.test(message) ||
    /timeout exceeded when trying to connect/i.test(message) ||
    /connection terminated/i.test(message) ||
    /too many (clients|connections)/i.test(message) ||
    /connection.*(closed|reset|refused)/i.test(message)
  );
}

/**
 * RETRIES A TRANSIENT FAILURE INSTEAD OF SILENTLY LOSING IT (2026-07-24,
 * real bug confirmed live in Render's logs during an actual 4-minute
 * tool-heavy turn: "Transaction API error: Unable to start a transaction
 * in the given time" fired 4 times in about a minute, alongside separate
 * "timeout exceeded when trying to connect" errors -- pooled-connection
 * (Neon PgBouncer) contention, not a code bug). Before this fix, the ONLY
 * caller of this function (route.ts's persistIncremental/persistFinal)
 * caught any failure here, logged it, and just kept going as if it had
 * succeeded -- meaning a transient multi-second DB hiccup permanently
 * dropped that step's save with no second attempt at all, even though
 * the very next incremental save (or the turn's own final save) might
 * have sailed through fine a few seconds later. 3 attempts with short
 * backoff (300ms/900ms) turns "one bad moment permanently loses this
 * step" into "one bad moment costs at most ~1.2s," which is exactly the
 * kind of resilience a hosted pooled Postgres endpoint needs under real
 * concurrent load. Still re-throws after exhausting retries so the
 * caller's own existing fallback (log + treat newMessages as the new
 * baseline for chaining, matching the old behavior) is the last resort,
 * not the first one.
 */
export async function mergeAndPersistChatEvents(
  chatId: string,
  userId: string,
  baseMessages: unknown[],
  newMessages: unknown[],
  extraFields: Record<string, unknown> = {},
): Promise<unknown[]> {
  const delays = [300, 900];
  for (let attempt = 0; ; attempt++) {
    try {
      return await runMergeTransaction(chatId, userId, baseMessages, newMessages, extraFields);
    } catch (err) {
      if (attempt >= delays.length || !isTransientDbError(err)) throw err;
      console.warn(
        '[direct chat] mergeAndPersistChatEvents transient DB error, retrying',
        chatId,
        attempt + 1,
        err instanceof Error ? err.message : err,
      );
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}
