'use client';

/**
 * Shared "follow the bottom while streaming" scroll engine (2026-07-17,
 * "improve streaming x5" push).
 *
 * WHY THIS EXISTS: direct-chat-interface.tsx already got a real fix here
 * (2026-07-17, "improve real time streaming") -- coalesce to one
 * requestAnimationFrame per paint instead of one smooth-scroll animation
 * per raw DOM mutation (which stutters/jiggles during fast streaming,
 * each new ~300ms animation getting cut off mid-flight by the next one a
 * few ms later), and only auto-follow while the user is already near the
 * bottom (so scrolling up to reread earlier context is never yanked back
 * down). chat-interface.tsx (the DEFAULT eve-agent chat path -- the one
 * most chats actually use) never got that same fix; it was still on the
 * old pattern, a plain `useEffect` keyed on `messages.length` alone, which
 * only fires once per whole message rather than continuously as a
 * message's own content grows token-by-token -- so a fast-streaming reply
 * on the default path visibly falls behind the bottom instead of tracking
 * it, then jumps once the NEXT message starts. Same root bug, just never
 * ported to the more commonly hit path. Fixing it once here, shared by
 * both, means it can't silently re-diverge between the two chat
 * implementations again.
 *
 * ALSO NEW here (neither path had this before): an async image inside the
 * scroll container -- a generated image, a screenshot render, etc. --
 * finishes loading and grows the container's real scrollHeight WITHOUT
 * any DOM mutation firing (the <img> tag itself doesn't change, just its
 * rendered box once decode completes) -- so the previous "auto-follow on
 * DOM mutation" approach on either path silently stopped tracking the
 * bottom the instant an image was the thing that grew the page. A
 * capturing `load` listener on the scroll container catches every
 * descendant image's load event (event capture/bubbling on 'load' works
 * for <img> specifically, confirmed against the DOM spec) and re-runs the
 * exact same follow check.
 */
import { useEffect, useRef } from 'react';

const NEAR_BOTTOM_PX = 120;

export function useStreamingAutoScroll(
  scrollRef: React.RefObject<HTMLElement | null>,
  /** Bump-able dependency that should trigger a fresh "snap to bottom"
   *  (smoothly, once) -- typically `messages.length` so a genuinely NEW
   *  turn starting always jumps down, distinct from the continuous
   *  per-frame follow that handles a turn's own content growing. */
  newTurnKey: unknown,
) {
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const isNearBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;

    // One deliberate smooth jump on a genuinely new turn starting.
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });

    const follow = () => {
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (!el) return;
        // Re-check near-bottom right before each follow (not just once at
        // mount) -- a user scrolling away mid-stream should stop being
        // auto-followed immediately, not just on the next new turn.
        if (isNearBottom()) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
      });
    };

    const observer = new MutationObserver(follow);
    observer.observe(el, { childList: true, subtree: true, characterData: true });

    // Image-load-aware following (2026-07-17) -- see file comment.
    const onImageLoad = (e: Event) => {
      if ((e.target as HTMLElement)?.tagName === 'IMG') follow();
    };
    el.addEventListener('load', onImageLoad, true);

    return () => {
      observer.disconnect();
      el.removeEventListener('load', onImageLoad, true);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newTurnKey]);
}
