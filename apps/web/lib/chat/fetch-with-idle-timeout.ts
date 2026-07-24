/**
 * Wraps `fetch` so a streaming response that goes silent for too long
 * aborts cleanly instead of hanging indefinitely.
 *
 * Real bug this fixes (2026-07-24, confirmed directly via Render's
 * service events API): mid-turn, Render's own liveness prober killed the
 * whole server instance (`server_failed ... "HTTP health check failed
 * (timed out after 5 seconds)"`) while a user's turn was actively
 * streaming tool calls. The DB-persistence side already survives this
 * fine (see persist-chat-events.ts — the turn's own background
 * continuation on the restarted instance finished the work and saved it,
 * confirmed by re-reading the row afterward: all tool calls + the final
 * text were there). The gap was purely on THIS side: the browser's
 * open fetch connection to the now-dead instance doesn't necessarily
 * error out quickly. Depending on exactly how the connection is torn
 * down (the OS-level TCP reset timing, and whatever Render's own
 * load-balancer/proxy does with an in-flight request to a backend that
 * just disappeared), the browser can be left with a fetch that simply
 * never receives another byte and never explicitly rejects either — no
 * error, no close, just silence. `useChat`'s `status` can stay stuck on
 * 'streaming' in exactly that scenario, and the existing stall-detection
 * recovery poll (see direct-chat-interface.tsx's STALL_MS logic) is a
 * good backup but is content-diffing based, not a hard guarantee.
 *
 * This closes the gap with an actual, standards-based mechanism: track
 * time since the LAST byte received on the response body stream (not
 * time since the request started — a legitimately long-running tool
 * call keeps producing bytes well within the window), and abort the
 * underlying fetch the moment that idle gap exceeds `idleMs`. An
 * aborted fetch throws a real, immediate AbortError that useChat's
 * transport catches and surfaces through the normal `onError` path —
 * which flips `chat.status` to 'error' right away, which is exactly the
 * condition the existing recovery poll already knows how to act on
 * (fetch the persisted snapshot, adopt it if it's more complete). This
 * doesn't replace that recovery logic, it just guarantees the trigger
 * fires promptly and reliably instead of possibly never firing at all.
 */
export function fetchWithIdleTimeout(idleMs: number): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const upstreamSignal = init?.signal;
    if (upstreamSignal) {
      if (upstreamSignal.aborted) controller.abort();
      else upstreamSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let idleTimer: ReturnType<typeof setTimeout> = setTimeout(() => {}, 0);
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        controller.abort(new DOMException('No data received from the server for a while — connection likely dropped.', 'TimeoutError'));
      }, idleMs);
    };
    resetIdleTimer();

    let response: Response;
    try {
      response = await fetch(input, { ...init, signal: controller.signal });
    } catch (err) {
      clearTimeout(idleTimer);
      throw err;
    }

    if (!response.body) {
      clearTimeout(idleTimer);
      return response;
    }

    const reader = response.body.getReader();
    const idleAwareBody = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const { done, value } = await reader.read();
          resetIdleTimer();
          if (done) {
            clearTimeout(idleTimer);
            streamController.close();
            return;
          }
          streamController.enqueue(value);
        } catch (err) {
          clearTimeout(idleTimer);
          streamController.error(err);
        }
      },
      cancel(reason) {
        clearTimeout(idleTimer);
        return reader.cancel(reason);
      },
    });

    return new Response(idleAwareBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
