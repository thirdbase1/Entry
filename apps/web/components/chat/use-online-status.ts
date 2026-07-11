'use client';

import { useEffect, useState } from 'react';

/**
 * Tracks the browser's online/offline state.
 *
 * Added 2026-07-11 alongside a real, reported UX gap: chat-interface.tsx's
 * and direct-chat-interface.tsx's recovery effects already detect and
 * silently repair a turn interrupted by a dropped connection (poll every
 * 3s + 'online'/'visibilitychange' listeners, refetch the persisted
 * session, adopt it if it has more content) -- but neither ever rendered
 * anything while that was happening. From the user's side, a real network
 * drop and a normal quiet moment look 100% identical: no "you're offline"
 * indicator, no "reconnecting…" state, and no confirmation once it's back
 * -- confirmed directly in both components, there was no consumer of
 * online/offline state anywhere in the render path at all. This hook is
 * the missing piece those banners now read from.
 *
 * `navigator.onLine` is read lazily (guarded for SSR, where `navigator`
 * doesn't exist) and kept in sync via the standard 'online'/'offline'
 * window events -- note these fire on a real connectivity change but are
 * NOT reliable on their own for "was the tab actually able to reach our
 * server" (a captive portal or flaky DNS can report `online: true` while
 * still failing every real request) -- that's exactly why the callers'
 * own poll-based recovery effects stay in place as the actual source of
 * truth for whether a turn is caught up; this hook only drives the
 * lightweight, purely informational banner text/copy choice.
 */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return isOnline;
}
