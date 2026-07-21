/**
 * Central client-side error reporter (2026-07-21).
 *
 * The gap this closes: /api/client-error existed but ONLY the root
 * <ErrorBoundary> ever called it, and React error boundaries by design
 * do NOT catch errors thrown inside event handlers (onClick), inside
 * unawaited promises, or inside setTimeout/rAF callbacks -- exactly
 * where a "click Send and nothing happens" bug lives. Those crashes hit
 * console.error (nobody's watching production console) and nothing else.
 * Zero server-side trace, ever -- confirmed by an empty
 * client-error-boundary log despite live user-facing failures.
 *
 * Two things now feed this same sink:
 *  1. Global `window.onerror` / `unhandledrejection` listeners
 *     (installed once, see global-error-reporter.tsx) -- catches truly
 *     silent crashes with zero surrounding try/catch.
 *  2. Every existing `setTurnError(...)` call site in chat-interface.tsx
 *     and direct-chat-interface.tsx now also calls this, so a send
 *     failure that WAS already being shown to the user as a banner is
 *     now ALSO a searchable server-side log entry with full context --
 *     "the user saw an error" stops being invisible to us too.
 */
export function reportClientError(message: string, extra?: Record<string, unknown>) {
  try {
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        message,
        url: typeof window !== 'undefined' ? window.location.href : undefined,
        stack: (extra as any)?.stack,
        componentStack: undefined,
        ...extra,
      }),
    }).catch(() => {});
  } catch {
    // never let logging itself throw
  }
}
