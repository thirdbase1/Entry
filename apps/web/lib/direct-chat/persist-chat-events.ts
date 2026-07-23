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
export async function mergeAndPersistChatEvents(
  chatId: string,
  userId: string,
  baseMessages: unknown[],
  newMessages: unknown[],
  extraFields: Record<string, unknown> = {},
): Promise<unknown[]> {
  const delta = newMessages.slice(baseMessages.length);

  return prisma.$transaction(async tx => {
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
    const merged = currentEvents.length > baseMessages.length ? [...currentEvents, ...delta] : newMessages;

    await tx.eveChatSession.update({
      where: { id: chatId, userId },
      data: { events: merged as any, ...extraFields },
    });

    return merged;
  });
}
