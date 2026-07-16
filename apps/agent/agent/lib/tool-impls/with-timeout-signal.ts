/**
 * Shared helper for the sub-generation tool-impls (code_artifact,
 * python_coding, task_analysis) that each make their own internal
 * generateText/generateObject call. Combines the real turn's own
 * cancellation signal (ctx.abortSignal) with a tool-local timeout, so a
 * slow/hung upstream model call fails fast with a clear, visible error
 * instead of riding along until the outer request's own maxDuration (300s,
 * direct/chat/route.ts) kills the entire turn with nothing surfaced to the
 * user — the "model uses a tool and stops without any errors" symptom.
 *
 * Usage:
 *   const t = withTimeoutSignal(ctx?.abortSignal, 75_000, 'code_artifact');
 *   try {
 *     await generateText({ ..., abortSignal: t.signal });
 *   } catch (err) {
 *     throw t.rethrow(err); // turns a timeout-abort into a readable Error
 *   } finally {
 *     t.clear();
 *   }
 */
export function withTimeoutSignal(outerSignal: AbortSignal | undefined, timeoutMs: number, toolName: string) {
  const timeoutController = new AbortController();
  const timer = setTimeout(
    () => timeoutController.abort(new Error(`${toolName} timed out after ${timeoutMs / 1000}s`)),
    timeoutMs
  );
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeoutController.signal]) : timeoutController.signal;

  return {
    signal,
    clear() {
      clearTimeout(timer);
    },
    /** Call from a catch block: converts a timeout-triggered abort into a readable Error, passes any other error through unchanged. */
    rethrow(err: unknown): unknown {
      if (timeoutController.signal.aborted) {
        return new Error(`${toolName} timed out after ${timeoutMs / 1000}s — try a smaller or simpler request, or split it into parts.`);
      }
      return err;
    },
  };
}
