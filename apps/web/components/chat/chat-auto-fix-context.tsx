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
 */
import { createContext, useContext } from 'react';

export type AutoFixSend = (message: string) => void;

const AutoFixSendContext = createContext<AutoFixSend | null>(null);

export function AutoFixSendProvider({ send, children }: { send: AutoFixSend; children: React.ReactNode }) {
  return <AutoFixSendContext.Provider value={send}>{children}</AutoFixSendContext.Provider>;
}

/** Null when no chat send path is mounted above the caller (shouldn't
 *  normally happen given where ChatPreviewPanel lives, but guarded rather
 *  than throwing -- a preview auto-fix hiccup should never crash the UI). */
export function useAutoFixSend(): AutoFixSend | null {
  return useContext(AutoFixSendContext);
}
