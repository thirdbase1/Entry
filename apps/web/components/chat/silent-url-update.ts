/**
 * Updates the address bar to a new chat URL WITHOUT going through Next's
 * App Router navigation.
 *
 * BUG (2026-07-20, user-reported "any time agent finish his first
 * response the page reloads"): every "new chat -> got its first
 * sessionId" call site used to do `router.replace('/chats/' + sid)`.
 * `/chats` (no id) and `/chats/[sessionId]` are two entirely separate
 * route leaves in the App Router tree (see app/(app)/chats/page.tsx vs
 * app/(app)/chats/[sessionId]/page.tsx) -- `router.replace` between them
 * unmounts <NewChatPage>/<ChatInterface> and mounts a brand new
 * <ChatSessionPage>/<ChatInterface> instance from scratch (a fresh
 * useEveAgent hook, a fresh EveAgentStore, fresh local state for
 * everything: scroll position, in-flight UI, the todo list, etc). It's
 * client-side SPA routing, not a real browser reload, but it's visually
 * indistinguishable from one -- the whole chat panel flashes and rebuilds
 * itself right as the user is reading the answer that just streamed in.
 *
 * Fix: change the URL directly via the History API instead. This updates
 * what's in the address bar (so refresh/copy-link/back-button all still
 * work correctly, and a REAL browser reload of that URL correctly lands
 * on the real /chats/[sessionId] route server-side) without Next's
 * router touching the currently-mounted component tree at all -- the
 * exact same <ChatInterface> instance just keeps running.
 */
export function silentlyUpdateChatUrl(path: string) {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === path) return;
  window.history.replaceState(window.history.state, '', path);
}
