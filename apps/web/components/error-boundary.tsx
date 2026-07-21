'use client';

/**
 * App-wide render error boundary (2026-07-21).
 *
 * Real gap this closes: every "nothing happens when I click X" report so
 * far (sign-in, send) traced back to either a genuine backend issue (now
 * ruled out -- direct curl against the exact production route the browser
 * hits streams a real answer fine) or, if it's client-side, a render-time
 * exception thrown somewhere in the tree with NO visible signal at all --
 * React unmounts the broken subtree, the page goes visually inert, and
 * there was previously nothing here to catch that and say so. A user
 * clicking a dead button has no way to tell "the app crashed" apart from
 * "the click didn't register" apart from "it's just slow" -- all three
 * look identical (nothing happens). This makes the first case loud and
 * recoverable instead of silent.
 *
 * Deliberately a class component -- React only supports error boundaries
 * via getDerivedStateFromError/componentDidCatch, no hook equivalent.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional label so nested boundaries (e.g. one per chat surface, in
   *  addition to the root one) can identify which region crashed in logs. */
  region?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[error-boundary${this.props.region ? `:${this.props.region}` : ''}]`, error, info.componentStack);
    try {
      void fetch('/api/client-error', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          region: this.props.region ?? 'root',
          message: error.message,
          stack: error.stack,
          componentStack: info.componentStack,
          url: typeof window !== 'undefined' ? window.location.href : undefined,
        }),
      }).catch(() => {});
    } catch {
      // never let logging itself throw
    }
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-[200px] w-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm font-medium text-foreground">Something broke on this page.</p>
        <p className="max-w-sm text-xs text-muted-foreground">{error.message || 'An unexpected error occurred.'}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-full border border-input px-4 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
