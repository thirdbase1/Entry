import { defineHook } from 'eve/hooks';
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
export default defineHook({
  events: {
    'turn.completed': async (_event, ctx) => {
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
    },
  },
});
