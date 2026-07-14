'use client';

/**
 * Bridges ChatPreviewPanel (rendered as `headerContent`, a sibling far
 * away from the actual send logic) to whichever `onSend` the active chat
 * path (eve default / BYOK direct) owns, WITHOUT prop-drilling through
 * ChatPageHeader -- React context doesn't care that ChatPageHeader lives
 * in a different file/module than the Provider; it only cares about tree
 * position, and `{headerContent}` is rendered as a descendant of this
 * Provider in both chat-interface.tsx and direct-chat-interface.tsx.
 *
 * Added 2026-07-11 for the preview auto-fix feature (see
 * use-preview-autofix.ts): when the sandbox preview can't connect, that
 * hook needs to actually inject a message into the LIVE chat turn (so the
 * agent sees the error and can call its own restart_sandbox/get_preview_url
 * tools) -- this is the only clean path to reach the real send function
 * from there.
 *
 * FIXED (2026-07-15, real confirmed bug -- "why if AI do tool calling it
 * stop instantly"): `send` used to be a bare function with no way for the
 * caller (use-preview-autofix.ts) to know whether a turn was already in
 * flight. On a brand-new chat, the very first turn often does real setup
 * work (bash/create_skill/etc.) for well over the old 12s stuck-threshold
 * before any dev server/sandbox preview exists to poll at all -- so the
 * auto-fix hook was calling this `send` (== the same `onSend`/`agent.send`
 * a real user turn uses) WHILE that first turn's own tool calls were still
 * actively streaming. `useChat`/eve's `agent.send` both treat a second
 * send while one is in flight as "start a new turn now," which aborts the
 * current one -- so the agent's own tool call got killed mid-flight by a
 * synthetic "the preview isn't connecting" message every single time,
 * looking exactly like "tool calling stops instantly." Now carries
 * `isBusy` alongside `send` so the poller can refuse to ever call `send`
 * while a turn is already running, instead of only finding out by
 * breaking it.
 */
import { createContext, useContext } from 'react';

export type AutoFixSend = (message: string) => void;

export type AutoFixSendValue = {
  send: AutoFixSend;
  /** True while a turn (any turn -- including the very first one) is
   *  actively streaming. The auto-fix poller must never call `send`
   *  while this is true. */
  isBusy: boolean;
  /** False for a chat with zero messages -- nothing to preview yet, the
   *  poller shouldn't even start hitting the preview status endpoint. */
  hasMessages: boolean;
};

const AutoFixSendContext = createContext<AutoFixSendValue | null>(null);

export function AutoFixSendProvider({
  send,
  isBusy,
  hasMessages,
  children,
}: {
  send: AutoFixSend;
  isBusy: boolean;
  hasMessages: boolean;
  children: React.ReactNode;
}) {
  return <AutoFixSendContext.Provider value={{ send, isBusy, hasMessages }}>{children}</AutoFixSendContext.Provider>;
}

/** Null when no chat send path is mounted above the caller (shouldn't
 *  normally happen given where ChatPreviewPanel lives, but guarded rather
 *  than throwing -- a preview auto-fix hiccup should never crash the UI). */
export function useAutoFixSend(): AutoFixSendValue | null {
  return useContext(AutoFixSendContext);
}
