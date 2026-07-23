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
 */
import { prisma } from '@entry/db';

/**
 * @param chatId       The chat session id.
 * @param userId       Owning user id (never trust a chatId alone).
 * @param baseMessages The message array THIS request started from (its
 *                      own snapshot of "history so far" before it added
 *                      anything of its own).
 * @param newMessages  The full reconstructed array this request wants to
 *                      persist -- baseMessages plus whatever this request
 *                      itself just added (a new user turn, a new
 *                      assistant reply, or both).
 * @param extraFields  Any other columns to set in the same update
 *                      (byokModelId/requestedModel on preSave's path).
 */
export async function mergeAndPersistChatEvents(
  chatId: string,
  userId: string,
  baseMessages: unknown[],
  newMessages: unknown[],
  extraFields: Record<string, unknown> = {},
): Promise<void> {
  const delta = newMessages.slice(baseMessages.length);

  await prisma.$transaction(async tx => {
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
  });
}
