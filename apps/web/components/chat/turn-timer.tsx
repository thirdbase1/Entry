/**
 * Per-turn response timer (2026-07-23, explicit user request: "show time
 * each AI response turn took when it stop... make sure it never glitch
 * or stay stuck, make sure it's correct").
 *
 * Two distinct sources of truth, deliberately never mixed:
 *
 * 1. LIVE (while a turn is still in flight): `useLiveTurnElapsedMs` below,
 *    a plain `setInterval` + `Date.now()` clock owned entirely by THIS
 *    client, started the instant `chat.status` first becomes 'submitted'
 *    (i.e. from the moment the user hits send, not just from first
 *    visible token — covers real think/TTFB time too, not only streaming
 *    time) and cleared the instant status leaves 'submitted'/'streaming'.
 *    Because it's a wall-clock interval, not something driven by chunk
 *    arrival, it can never "get stuck" waiting on a chunk that's slow to
 *    arrive — heartbeats, thinking pauses, tool calls, all just keep
 *    ticking normally, same as a real stopwatch.
 *
 * 2. FINAL (once a turn is done): `message.metadata.durationMs`, computed
 *    SERVER-SIDE in route.ts from its own `requestStartedAt` to the exact
 *    instant the whole turn (every step, every tool call) truly finishes
 *    — see that file's `messageMetadata` comment. This is the one and
 *    only authoritative number: it rides the same message reconstruction
 *    onFinish already uses to persist `sanitizedFinalMessages`, so the
 *    figure shown live the moment a turn completes is IDENTICAL to what's
 *    still there after a full page reload — no separate client timer to
 *    ever drift out of sync with what actually got saved.
 *
 * The live clock is ONLY ever shown for a turn that has no durationMs yet
 * (i.e. still genuinely in flight) — the instant durationMs shows up, the
 * live interval component isn't even rendered anymore (see
 * direct-chat-interface.tsx's call site), so there is no seam where a
 * stale live number could keep ticking past, or visibly jump against, the
 * real final one.
 */
import { useEffect, useRef, useState } from 'react';

/** mm:ss / plain seconds formatting -- never shows a negative or NaN
 *  value (clamped to 0) so a clock-skew edge case renders "0.0s" instead
 *  of something nonsensical. */
export function formatTurnDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = clamped / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

/**
 * How long `active` may sit false before this hook treats the turn as
 * genuinely over and actually clears the clock. Added 2026-08-08 (live
 * bug: "timer resets every ~1 minute"). Root cause: `active` here is fed
 * by `isBusy` = `chat.status === 'submitted' || 'streaming' || pendingTurn`
 * -- across a leg boundary in the workflow-based turn pipeline (or any
 * brief reconnect gap) `chat.status` can fall back to 'ready' for a
 * render or two before the recovery poll re-confirms `pendingTurn`, so
 * `active` genuinely DOES flicker false->true within the same still-in-
 * -flight turn. The old code treated every `active===false` instant as
 * "the turn ended", wiping `startRef` and restarting the count from 0 the
 * moment `active` flipped back on -- indistinguishable, visually, from
 * the timer randomly resetting mid-turn. A short grace window absorbs
 * exactly that kind of blip: the start time is only actually forgotten if
 * `active` stays false for the whole window, i.e. the turn is really
 * done (or was already reset by the `active` effect below moving on to a
 * genuinely NEW turn, in which case a fresh startRef is set right away
 * regardless of any pending clear).
 */
const RESET_GRACE_MS = 4_000;

/**
 * Ticks roughly every 100ms while `active` is true, tracking elapsed time
 * from the moment `active` FIRST became true. A brief `active` flicker
 * false (see RESET_GRACE_MS's comment) does not restart the clock -- only
 * `active` staying false past the grace window actually clears it, so a
 * genuinely new turn still always starts a fresh count.
 */
export function useLiveTurnElapsedMs(active: boolean): number | null {
  const startRef = useRef<number | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (!active) {
      // Don't nuke startRef synchronously -- give it RESET_GRACE_MS to see
      // if this is a real end-of-turn or just a transient reconnect blip.
      if (clearTimerRef.current == null) {
        clearTimerRef.current = setTimeout(() => {
          startRef.current = null;
          setElapsed(null);
          clearTimerRef.current = undefined;
        }, RESET_GRACE_MS);
      }
      return;
    }
    // Genuinely active again -- cancel any pending clear from a blip, and
    // keep the EXISTING startRef (if this is a same-turn reconnect) so
    // the count continues seamlessly instead of jumping back to 0.
    if (clearTimerRef.current != null) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = undefined;
    }
    if (startRef.current == null) {
      startRef.current = Date.now();
      setElapsed(0);
    }
    const id = setInterval(() => {
      if (startRef.current != null) setElapsed(Date.now() - startRef.current);
    }, 100);
    return () => clearInterval(id);
  }, [active]);

  // Pending-clear timer must survive unmount cleanup only for as long as
  // the component itself does -- clear it if the component goes away
  // entirely so it never fires setState on an unmounted component.
  useEffect(() => {
    return () => {
      if (clearTimerRef.current != null) clearTimeout(clearTimerRef.current);
    };
  }, []);

  return elapsed;
}

/** Small muted footer label under a completed assistant message. */
export function TurnDurationLabel({ durationMs }: { durationMs: number }) {
  return (
    <div className="text-xs text-muted-foreground/70 mt-1 select-none" title="Time this response took to fully finish">
      {formatTurnDuration(durationMs)}
    </div>
  );
}

/** Live ticking counter shown only while a turn is still in flight. */
export function LiveTurnDurationLabel({ elapsedMs }: { elapsedMs: number }) {
  return (
    <div className="text-xs text-muted-foreground/70 mt-1 select-none tabular-nums" title="Elapsed time so far">
      {formatTurnDuration(elapsedMs)}
    </div>
  );
}
