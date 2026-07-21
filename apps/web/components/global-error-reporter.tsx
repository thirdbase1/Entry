'use client';

/**
 * Root-mounted, render-nothing component that installs the two browser
 * hooks React error boundaries structurally cannot cover:
 *
 *  - `window.addEventListener('error', ...)`: catches exceptions thrown
 *    inside event handlers (onClick, onKeyDown, ...), inside
 *    setTimeout/rAF callbacks, and inside any plain synchronous code
 *    NOT wrapped in a local try/catch. This is exactly the shape of a
 *    "click Send and nothing happens" bug -- `handleSend` in
 *    chat-input.tsx already has a local try/catch around `onSend()`,
 *    but nothing upstream of that (e.g. a hook throwing during a state
 *    update triggered by the click) would be caught by it.
 *
 *  - `window.addEventListener('unhandledrejection', ...)`: catches a
 *    rejected promise that nothing ever attached a `.catch()` to. The
 *    chat send paths here are already careful about this
 *    (sendWithRetry(...).catch(...) in direct-chat-interface.tsx,
 *    onSend's own try/catch in chat-interface.tsx) but this is cheap
 *    insurance against the *next* one, in this file or any other, that
 *    isn't as careful -- and against third-party code (extensions,
 *    injected scripts) that can also fire these events.
 *
 * Before this, a crash in either category produced a console.error in a
 * browser tab nobody is watching and ZERO server-side trace -- confirmed
 * by an /api/admin/errors?source=client-error-boundary query coming back
 * completely empty despite live, reported "silent" send failures.
 * Mounted once in app/layout.tsx, outside (above) the root ErrorBoundary
 * so it keeps working even if the boundary itself is what's rendering.
 */
import { useEffect } from 'react';
import { reportClientError } from '@/lib/report-client-error';

export function GlobalErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      reportClientError(event.message || 'Unhandled window error', {
        region: 'window-onerror',
        stack: event.error instanceof Error ? event.error.stack : undefined,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Unhandled promise rejection';
      reportClientError(message, {
        region: 'unhandled-rejection',
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}
