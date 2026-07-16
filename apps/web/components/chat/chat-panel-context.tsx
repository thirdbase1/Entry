'use client';

/**
 * Tiny cross-component signal so tapping a Version card (deep inside the
 * direct-chat message list, see renderers/version-card.tsx) can open the
 * side ChatPreviewPanel to its "History" tab (chat-versions-tab.tsx) —
 * the panel's open/closed + tab state both live in ChatPageHeader/
 * ChatPreviewPanel, a SIBLING of the message list under DirectChatSession
 * (both receive `headerContent`/render the message list from the same
 * parent — see direct-chat-interface.tsx), not an ancestor of it, so a
 * plain prop can't reach across. This context is provided once at that
 * shared parent instead of threading a callback through every layer.
 *
 * Same pattern already used in this file's neighbor,
 * chat-auto-fix-context.tsx, for the exact same "sibling components need
 * to talk" shape.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface ChatPanelContextValue {
  /** Bumped to a new version number each time a card is tapped — consumers
   *  watch this value change (not just truthiness) so tapping the SAME
   *  version twice in a row still re-triggers the open. */
  historyRequestVersion: number | null;
  historyRequestNonce: number;
  requestOpenHistory: (versionNumber: number) => void;
}

const ChatPanelContext = createContext<ChatPanelContextValue | null>(null);

export function ChatPanelProvider({ children }: { children: ReactNode }) {
  const [historyRequestVersion, setHistoryRequestVersion] = useState<number | null>(null);
  const [historyRequestNonce, setHistoryRequestNonce] = useState(0);

  const value = useMemo<ChatPanelContextValue>(
    () => ({
      historyRequestVersion,
      historyRequestNonce,
      requestOpenHistory: (versionNumber: number) => {
        setHistoryRequestVersion(versionNumber);
        setHistoryRequestNonce(n => n + 1);
      },
    }),
    [historyRequestVersion, historyRequestNonce],
  );

  return <ChatPanelContext.Provider value={value}>{children}</ChatPanelContext.Provider>;
}

/** Safe no-op fallback when rendered outside a provider (e.g. the
 *  eve-default chat path, which never renders a version card at all —
 *  see chat-versioning.ts's appendVersionCardMessage) so callers never
 *  need to guard against a missing provider themselves. */
export function useChatPanel(): ChatPanelContextValue {
  const ctx = useContext(ChatPanelContext);
  if (!ctx) return { historyRequestVersion: null, historyRequestNonce: 0, requestOpenHistory: () => {} };
  return ctx;
}
