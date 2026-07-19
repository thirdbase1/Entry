'use client';

/**
 * Drop-in replacement for eve/react's own `useEveAgent` that fixes the real
 * "streaming lags / doesn't auto-scroll, worse the faster the model is"
 * report (2026-07-18).
 *
 * ROOT CAUSE, confirmed directly against eve@0.20.0's shipped source
 * (node_modules/eve/dist/src/client/eve-agent-store.js +
 * dist/src/react/use-eve-agent.js): `EveAgentStore.send()` calls its
 * private `#O()` notify method once per raw stream event, synchronously,
 * inside the `for await (const event of stream)` loop -- zero batching.
 * `useEveAgent` wires that straight into React's `useSyncExternalStore`,
 * so React re-renders this component (and re-diffs the ENTIRE message
 * list under it) once per network event, with no ceiling. A slow model
 * emits maybe 2-5 events/sec, invisible. A fast model can emit 50-100+
 * events/sec -- ~100 fully synchronous re-renders a second is more
 * render/diff work than any browser main thread can keep up with, so
 * frames get dropped: the text visibly lags behind what actually arrived,
 * and separately, use-streaming-autoscroll.ts's own rAF-scheduled
 * "follow the bottom" callback has to fight the SAME saturated main
 * thread for a chance to run, so it also visibly falls behind or seems to
 * stop -- one root cause explains both complaints, and why it only shows
 * up "when the model is super fast".
 *
 * THE FIX: subscribe to the store the same way, but coalesce however many
 * notify() calls land within one animation frame down to a single React
 * re-render for that frame -- the same rAF-coalescing pattern
 * use-streaming-autoscroll.ts already uses for DOM-mutation-driven
 * scrolling, applied here to the store subscription itself. This caps
 * render frequency at the display's real refresh rate (~60/sec) no matter
 * how many events arrive per frame, while `getSnapshot()` always reads
 * the store's live `.snapshot` getter -- so no event or token is ever
 * delayed in the DATA (the store's internal state is exactly as current
 * as before); only how often React is told to re-render is throttled.
 * Worst case added latency to see a burst of tokens: <16ms, imperceptible.
 *
 * Built entirely on eve's public API (`eve/client`'s exported
 * `EveAgentStore` + `defaultMessageReducer`, the same class `eve/react`
 * itself wraps) -- no reach into internal `#`-prefixed paths, no patching
 * node_modules, safe across an `eve` version bump as long as this public
 * surface stays stable.
 */
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { EveAgentStore, defaultMessageReducer } from 'eve/client';
import type {
  EveMessageData,
  PrepareSend,
  UseEveAgentHelpers,
  UseEveAgentOptions,
} from 'eve/react';

export function useThrottledEveAgent<TData = EveMessageData>(
  options: UseEveAgentOptions<TData> = {},
): UseEveAgentHelpers<TData> {
  const storeRef = useRef<EveAgentStore<TData> | null>(null);
  if (!storeRef.current) {
    const reducer = options.reducer ?? (defaultMessageReducer() as unknown as UseEveAgentOptions<TData>['reducer']);
    storeRef.current = new EveAgentStore<TData>({
      auth: options.auth,
      headers: options.headers,
      host: options.host,
      initialEvents: options.initialEvents,
      initialSession: options.initialSession,
      maxReconnectAttempts: options.maxReconnectAttempts,
      optimistic: options.optimistic,
      reducer: reducer!,
      session: options.session,
    });
  }
  const store = storeRef.current;

  // Callbacks update every render (matches eve/react's own behavior) --
  // cheap object assignment, no subscription churn.
  store.setCallbacks({
    onError: options.onError,
    onEvent: options.onEvent,
    onFinish: options.onFinish,
    onSessionChange: options.onSessionChange,
    prepareSend: options.prepareSend as PrepareSend | undefined,
  });

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      let rafId: number | null = null;
      const unsubscribe = store.subscribe(() => {
        if (rafId !== null) return; // a flush is already scheduled for this frame
        rafId = requestAnimationFrame(() => {
          rafId = null;
          // REVERTED (2026-07-19, same day -- confirmed real regression,
          // reported as "streaming doesn't work at all now, hangs, then a
          // wall of text dumps in once the agent stops"): wrapping this in
          // `startTransition` was meant to stop a fast agent's constant
          // stream of rAF-scheduled updates from starving input, but
          // `startTransition` renders are explicitly interruptible/
          // supersedable -- if a NEW rAF-scheduled transition gets kicked
          // off (every ~16ms, for as long as the model keeps streaming)
          // before React finishes committing+painting the PREVIOUS one,
          // React is allowed to throw the in-progress render away and
          // start over with the newer state. Under a genuinely fast model
          // that's every single frame, forever -- so the transition can
          // legitimately never reach a commit until the source of updates
          // stops (the agent finishes), which is exactly "hangs the whole
          // time, then dumps everything at once" from the outside.
          // The 2026-07-18 fix (messagePropsAreEqual in message-renderer.tsx)
          // already made each individual frame's render cheap -- only the
          // actively-streaming message re-renders now, not the whole
          // thread -- so the ORIGINAL "page hangs, can't scroll" complaint
          // this was trying to solve should mostly be addressed by that
          // memoization alone, at default priority, without also needing
          // to make the render itself preemptible (and, in doing so, risk
          // it never landing). Back to a plain default-priority update:
          // rAF still caps this to at most one render per display frame
          // (~60/sec ceiling) no matter how many raw store notify() calls
          // land in between, which is the part that's genuinely needed.
          onStoreChange();
        });
      });
      return () => {
        unsubscribe();
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    },
    [store],
  );

  const snapshot = useSyncExternalStore(
    subscribe,
    () => store.snapshot,
    () => store.snapshot,
  );

  const reset = useCallback(() => store.reset(), [store]);
  const send = useCallback((input: Parameters<UseEveAgentHelpers<TData>['send']>[0]) => store.send(input), [store]);
  const stop = useCallback(() => store.stop(), [store]);

  return useMemo(
    () => ({ ...snapshot, reset, send, stop }) as UseEveAgentHelpers<TData>,
    [snapshot, reset, send, stop],
  );
}
