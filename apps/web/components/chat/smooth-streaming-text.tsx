'use client';

/**
 * CLIENT-SIDE STREAMING SMOOTHING (2026-07-27).
 *
 * Problem: `smoothStream({ delayInMs: 3 })` on the server re-chunks by
 * word with a 3ms delay, but the NETWORK between server and client
 * batches these word-chunks unpredictably — TCP Nagle, proxy buffering,
 * CDN coalescing. The client receives bursts of 20-50 words at once
 * followed by gaps, rendering as visual jumps instead of a smooth
 * stream. This is worse the faster the model is (more words per burst)
 * and worse on bad internet (longer gaps between bursts, more lag).
 *
 * Solution: smooth on the CLIENT. This component sits between `useChat`'s
 * message parts and `MarkdownText`. It receives the full accumulated
 * text (which grows as chunks arrive) and reveals it at a steady rate
 * using requestAnimationFrame. Key properties:
 *
 *  - Fast model, good internet: text grows fast → reveal at an accelerated
 *    rate to keep up without visual jumps.
 *  - Slow model, good internet: text grows slowly → reveal at the
 *    arrival rate → no artificial delay.
 *  - Bad internet: text arrives in bursts with gaps → buffer during
 *    bursts, continue revealing during gaps → smooth even when the
 *    network stutters.
 *  - Stream complete: immediately flush all remaining text.
 *  - DB snapshot replacement (text shrinks/changes): snap to new text
 *    immediately — never display stale content.
 *
 * RE-RENDER THROTTLING: setDisplayedText is called at most every
 * RENDER_THROTTLE_MS (50ms ≈ 3 frames at 60fps), NOT on every frame.
 * MarkdownText re-parses markdown on every render, so 60 renders/second
 * for a long message is extremely expensive. Throttling to ~20 renders/s
 * is visually indistinguishable and dramatically reduces CPU usage.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { MarkdownText } from '@/components/ui/markdown';

// Reveal rate: characters per animation frame (~16ms at 60fps).
const BASE_CHARS_PER_FRAME = 3;
// If the buffer exceeds this, accelerate to catch up (prevents unbounded
// buffer growth on fast models).
const CATCHUP_THRESHOLD = 60;
const CATCHUP_CHARS_PER_FRAME = 12;
// Minimum buffer before starting to reveal (prevents single-char trickling).
const MIN_BUFFER = 2;
// Throttle React state updates to this interval (ms). This limits
// MarkdownText re-parses to ~20/s, keeping the UI smooth without
// burning CPU on 60/s markdown re-renders.
const RENDER_THROTTLE_MS = 50;

function SmoothStreamingTextImpl({
  text,
  loading,
}: {
  text: string;
  loading: boolean;
}) {
  // displayedText is the text actually rendered by MarkdownText.
  // We update it at most every RENDER_THROTTLE_MS via the rAF loop.
  const [displayedText, setDisplayedText] = useState(text);
  const fullTextRef = useRef(text);
  const displayedRef = useRef(text);
  const rafRef = useRef<number | null>(null);
  const lastRenderRef = useRef(0);
  // pendingDisplayRef holds the text we've revealed via rAF but haven't
  // yet flushed to React state. This decouples the reveal animation
  // (runs every frame) from React re-renders (throttled).
  const pendingDisplayRef = useRef(text);

  // Update the full text reference when new text arrives.
  fullTextRef.current = text;

  useEffect(() => {
    // If not streaming, show full text immediately and stop animating.
    if (!loading) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Flush immediately — the stream is done.
      displayedRef.current = text;
      pendingDisplayRef.current = text;
      setDisplayedText(text);
      return;
    }

    // Streaming: start the animation loop.
    // Only restart the loop if it's not already running (it reads from
    // refs, so it picks up new text automatically without needing to
    // re-run this effect on every text change).
    if (rafRef.current) return; // Already running

    const animate = () => {
      const full = fullTextRef.current;
      const current = displayedRef.current;

      // Handle text shrink (DB snapshot replaced the message with
      // different/shorter content): snap to the new text immediately.
      if (full.length < current.length || !full.startsWith(current.slice(0, Math.min(current.length, full.length)))) {
        displayedRef.current = full;
        pendingDisplayRef.current = full;
        setDisplayedText(full);
        lastRenderRef.current = performance.now();
        rafRef.current = requestAnimationFrame(animate);
        return;
      }

      const buffer = full.length - current.length;

      if (buffer > 0 && buffer >= MIN_BUFFER) {
        // Adaptive reveal rate: accelerate if buffer is large.
        const charsPerFrame = buffer > CATCHUP_THRESHOLD
          ? CATCHUP_CHARS_PER_FRAME
          : BASE_CHARS_PER_FRAME;
        const revealCount = Math.min(charsPerFrame, buffer);
        const newText = full.slice(0, current.length + revealCount);
        displayedRef.current = newText;
        pendingDisplayRef.current = newText;
      }

      // Throttle React state updates to RENDER_THROTTLE_MS.
      const now = performance.now();
      if (now - lastRenderRef.current >= RENDER_THROTTLE_MS) {
        setDisplayedText(pendingDisplayRef.current);
        lastRenderRef.current = now;
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [loading]); // Only re-run when loading changes, NOT on every text update

  // When loading is true, the effect reads text from fullTextRef (updated
  // on every render via the assignment at the top). But we also need to
  // flush the final state when text changes while loading — use a
  // separate effect for that.
  useEffect(() => {
    if (!loading) {
      // Already handled by the main effect's !loading branch.
      return;
    }
    // If text shrank or changed completely (DB snapshot replacement),
    // the animate loop will handle it on the next frame via the shrink
    // check. No action needed here — just let the rAF loop pick it up.
  }, [text, loading]);

  return <MarkdownText text={displayedText} loading={loading} />;
}

export const SmoothStreamingText = memo(SmoothStreamingTextImpl);
