'use client';

/**
 * "Put a browser preview somewhere in the UI, powered by the sandbox of
 * each chat" — the button lives in ChatPageHeader; this is the actual
 * panel it opens.
 *
 * Rebuilt 2026-07-11 (explicit user request: "the preview is having
 * issues, it should always connect... if the preview have issues
 * connecting it should send it automatically to the AI to fix, showing
 * the error -- not when I click preview should it be stating [the
 * error]"): this component used to own its own polling + restart calls,
 * meaning nothing happened at all unless the user had this panel open.
 * Polling, the stuck-detection, the self-heal restart attempt, and the
 * auto-escalation to the agent all now live in `usePreviewAutoFix`
 * (mounted in ChatPageHeader, always running while the chat page is
 * open) -- this component is purely presentational over whatever that
 * hook reports, so a broken preview gets auto-fixed whether or not this
 * panel is ever opened. See that hook's file comment for the full
 * self-heal-then-escalate behavior and ChatPreview's schema comment
 * (packages/db/prisma/schema.prisma) for the two-path (direct vs eve)
 * rationale.
 */
import { useState } from 'react';
import type { PreviewStatus } from './use-preview-autofix';

export function ChatPreviewPanel({
  sessionId: _sessionId,
  state,
  autoFixing,
  onManualRestart,
  onRefresh,
  onClose,
}: {
  sessionId: string;
  state: PreviewStatus | null;
  autoFixing: boolean;
  onManualRestart: () => Promise<unknown>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [restarting, setRestarting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const restart = async () => {
    setRestarting(true);
    try {
      await onManualRestart();
      await onRefresh();
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[480px] bg-card border-l border-border z-50 flex flex-col shadow-xl">
      <div className="h-14 border-b border-border px-4 flex items-center justify-between shrink-0">
        <div className="text-sm font-medium">Preview</div>
        <div className="flex items-center gap-2">
          {state?.available && (
            <button
              onClick={() => setReloadKey(k => k + 1)}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent"
              title="Reload preview"
            >
              Reload
            </button>
          )}
          <button
            onClick={restart}
            disabled={restarting}
            className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent disabled:opacity-50"
          >
            {restarting ? 'Restarting…' : 'Restart'}
          </button>
          <button onClick={onClose} className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-accent text-muted-foreground">
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative bg-background">
        {!state && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">Checking…</div>}

        {state && state.available && state.url && (
          <iframe key={reloadKey} src={state.url} className="w-full h-full border-0" title="App preview" />
        )}

        {state && !state.available && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="text-sm text-muted-foreground">
              {state.status === 'error' ? state.error || 'Something went wrong starting the preview.' : 'Starting…'}
            </div>
            {autoFixing ? (
              <div className="flex items-center gap-2 text-xs text-amber-600">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
                Not connecting — I've already flagged this to the agent to fix. It'll reconnect automatically once fixed.
              </div>
            ) : (
              state.requiresAgentAction && (
                <div className="text-xs text-muted-foreground max-w-xs">Starting up — this will reconnect automatically once it's ready.</div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
