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
 * Ticks roughly every 100ms while `active` is true, tracking elapsed time
 * from the moment `active` FIRST became true. Resets cleanly the instant
 * `active` goes false (returns null) so a new turn always starts a fresh
 * count instead of ever continuing/inheriting a previous turn's clock.
 */
export function useLiveTurnElapsedMs(active: boolean): number | null {
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (!active) {
      startRef.current = null;
      setElapsed(null);
      return;
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
