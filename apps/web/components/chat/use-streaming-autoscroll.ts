'use client';

/**
 * Shared "follow the bottom while streaming" scroll engine (2026-07-17,
 * "improve streaming x5" push; REWRITTEN 2026-07-19, user: "when agent is
 * working the chat doesn't auto scroll at allll").
 *
 * WHY THE REWRITE: the previous version decided whether to keep following
 * by DISTANCE — auto-scroll only if currently within 120px of the bottom.
 * That heuristic breaks exactly during agent work: a tool card / big
 * markdown block / tool result lands as ONE large DOM mutation that grows
 * the container by far more than 120px in a single frame, so by the time
 * the follow callback runs, the viewport is already "too far" from the
 * bottom and the check concludes the user must have scrolled up — and
 * stops following, permanently, until the next turn. Token-by-token text
 * streaming stayed under the threshold, which is why plain replies
 * followed fine but tool-heavy agent turns (big appends) "don't auto
 * scroll at all".
 *
 * Fix: replace distance-as-intent with an explicit sticky `following`
 * flag that models what the user actually did:
 *  - following starts true (and re-arms on every new turn),
 *  - it turns OFF only on a genuine user-initiated scroll away from the
 *    bottom (wheel up, touch drag, PageUp/Home/ArrowUp/etc., or a scroll
 *    event we didn't programmatically cause),
 *  - it turns back ON the moment the user returns to the bottom
 *    themselves (or a new turn starts).
 * While following, every content growth snaps the view down regardless of
 * how large the jump was. Programmatic scrolls are marked so the scroll
 * listener never mistakes our own follow for user intent.
 *
 * Retained from the previous version (both were real fixes):
 *  - coalesce to at most one scroll per animation frame (rAF), instant
 *    'auto' behavior for per-frame follows — smooth animations per
 *    mutation stutter/fight each other during fast streaming,
 *  - capturing 'load' listener so an async <img> finishing decode (which
 *    grows scrollHeight with NO DOM mutation) still triggers a follow.
 */
import { useEffect, useRef } from 'react';

// Within this distance of the bottom counts as "at the bottom" — both for
// re-arming follow when the user returns, and for tolerating sub-pixel /
// rounding drift without treating it as a scroll-away.
const AT_BOTTOM_PX = 60;

export function useStreamingAutoScroll(
  scrollRef: React.RefObject<HTMLElement | null>,
  /** Bump-able dependency that should trigger a fresh "snap to bottom"
   *  (smoothly, once) and re-arm following -- typically `messages.length`
   *  so a genuinely NEW turn always jumps down even if the user had
   *  scrolled away during the previous one. */
  newTurnKey: unknown,
) {
  const rafIdRef = useRef<number | null>(null);
  const followingRef = useRef(true);
  // True while a scroll event we caused ourselves is expected — lets the
  // scroll listener tell "our follow moved the bar" apart from "the user
  // moved the bar". Reset on the next scroll event after each programmatic
  // move (scrollTo with behavior 'smooth' fires many scroll events; keep
  // it set until the position actually reaches the bottom).
  const programmaticRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const isAtBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;

    const scrollToBottom = (behavior: ScrollBehavior) => {
      programmaticRef.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior });
    };

    // New turn: re-arm and take one deliberate smooth jump down.
    followingRef.current = true;
    scrollToBottom('smooth');

    const follow = () => {
      if (!followingRef.current || rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (followingRef.current) scrollToBottom('auto');
      });
    };

    // --- user-intent listeners: the ONLY things that stop following ---
    // Wheel/touch/keys are unambiguous (only a human produces them);
    // checking deltaY/key direction means scrolling down to the bottom
    // never has to fight the follow engine.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) followingRef.current = false;
    };
    const onTouchMove = () => {
      // Any touch drag counts as taking manual control; re-arms below if
      // they end up back at the bottom.
      if (!isAtBottom()) followingRef.current = false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') followingRef.current = false;
    };
    // Scrollbar drags produce scroll events with no wheel/touch/key — any
    // scroll we didn't cause ourselves that lands away from the bottom is
    // user intent too. And ANY path back to the bottom re-arms following.
    const onScroll = () => {
      if (isAtBottom()) {
        followingRef.current = true;
        programmaticRef.current = false;
      } else if (!programmaticRef.current) {
        followingRef.current = false;
      }
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('scroll', onScroll, { passive: true });

    const observer = new MutationObserver(follow);
    observer.observe(el, { childList: true, subtree: true, characterData: true });

    // Image-load-aware following (2026-07-17) -- see file comment.
    const onImageLoad = (e: Event) => {
      if ((e.target as HTMLElement)?.tagName === 'IMG') follow();
    };
    el.addEventListener('load', onImageLoad, true);

    return () => {
      observer.disconnect();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('load', onImageLoad, true);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newTurnKey]);
}
