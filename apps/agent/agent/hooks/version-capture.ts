import { defineHook } from 'eve/hooks';
import type { HookContext } from 'eve/hooks';
import { captureVersionFromSandboxDiff } from '@entry/db/chat-versioning';

/**
 * Universal, tool-agnostic version capture for the eve-default chat path.
 *
 * REAL BUG FIXED (2026-07-16): "no matter the tool it use to change
 * something in file... the card should show instantly". Versioning used
 * to be wired into individual tools (write_file/edit_file/append_file
 * only) -- any change made via `bash` directly (rm, mv, sed -i, a build
 * script writing generated files, literally anything else) was invisible
 * to it, and eve-default chats never got a visible version card at all
 * (the old design only ever appended the card into BYOK/direct chats'
 * `events`, since eve's own event-log shape can't safely hold a spliced-
 * in raw UIMessage -- see chat-versioning.ts's file comment).
 *
 * Fix, this file: subscribe to eve's own `turn.completed` stream event --
 * fires the instant eve durably records that the turn is over, i.e. "the
 * agent stopped" in the user's own words, server-side, with zero client
 * involvement needed to trigger it. `ctx.getSandbox()` resolves the
 * SAME live sandbox this turn's tool calls (if any) actually used, so
 * `captureVersionFromSandboxDiff` diffs its real, current filesystem
 * state against the git baseline committed at the end of the previous
 * turn -- this catches every change regardless of which tool made it,
 * because it reads the actual disk rather than instrumenting each tool.
 *
 * `getSandbox()` throws when the turn never touched a sandbox at all
 * (e.g. a purely conversational turn, no tool calls) -- caught and
 * ignored below, exactly right: nothing to version.
 *
 * This ONLY writes the ChatVersion/ChatVersionFile rows (durable, shows
 * up in the read-only Versions tab immediately either way). It does NOT
 * try to inject a card into eve's own event log -- hooks are observe-only
 * by design and can't do that safely. The visible, INSTANT in-chat card
 * for eve-default chats is rendered purely client-side instead: this
 * same `turn.completed` event is what the browser's `useEveAgent` stream
 * already receives live, and chat-interface.tsx's `onEvent` handler (see
 * that file) reacts to it by fetching this exact version from the
 * versions-list route and rendering it locally the moment it arrives --
 * no polling delay, no page reload, works identically for every chat
 * whether it's eve-default or BYOK.
 */
const capture = async (_event: unknown, ctx: HookContext) => {
  try {
    const sandbox = await ctx.getSandbox();
    await captureVersionFromSandboxDiff(ctx.session.id, sandbox);
  } catch (err) {
    // Most common case by far: this turn never used a sandbox at all
    // (pure conversation, no tool calls) -- getSandbox() throws, and
    // there is genuinely nothing to version. Anything else (a real
    // sandbox/git hiccup) is still just best-effort, same philosophy
    // as every other piece of this feature -- never let a versioning
    // failure look like the turn itself failed.
    const message = err instanceof Error ? err.message : String(err);
    if (!/no sandbox/i.test(message)) {
      console.error('[version-capture hook] failed', ctx.session.id, err);
    }
  }
};

export default defineHook({
  events: {
    // BROADENED (2026-07-18, user-reported: "sandbox kept cleaning up
    // file, it's not persistent"). This used to only fire on
    // `turn.completed` -- ONE snapshot per whole turn, at the very end.
    // Real bug: `restoreLatestFilesToSandbox` (used whenever an evicted/
    // reset sandbox needs to be rebuilt) only ever restores from the
    // LAST git-committed baseline, which this hook is the only thing
    // that advances. Any turn that never reaches a clean `turn.completed`
    // -- a long tool call hitting the outer request's own maxDuration and
    // getting hard-killed by the platform mid-turn, a crash, a dropped
    // connection -- left the baseline stuck wherever it was after the
    // PREVIOUS turn, silently losing every file change made during the
    // one that got cut off, the instant that sandbox was later evicted
    // and rebuilt from that stale baseline. `step.completed` fires after
    // EVERY individual model step within a turn (tool call and result
    // included), not just once at the end, so the baseline now advances
    // incrementally as the turn progresses -- a hard-kill mid-turn now
    // only ever loses whatever happened after the last completed step,
    // not the entire turn. `step.failed` covers the same gap for a step
    // that errors outright (a tool call can still have written real
    // files before the step itself failed). captureVersionFromSandboxDiff
    // is already a cheap, safe no-op when nothing actually changed on
    // disk, so firing it this much more often costs nothing extra when
    // there's no diff to record.
    'step.completed': capture,
    'step.failed': capture,
    'turn.completed': capture,
  },
});
