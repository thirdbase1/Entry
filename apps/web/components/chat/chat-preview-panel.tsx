'use client';

/**
 * "Put a browser preview somewhere in the UI, powered by the sandbox of
 * each chat" — the button lives in ChatPageHeader; this is the actual
 * panel it opens. Polls GET /api/chats/[sessionId]/preview.
 *
 * See ChatPreview's schema comment (packages/db/prisma/schema.prisma) and
 * the route's own file comment (app/api/chats/[sessionId]/preview/
 * route.ts) for the full two-path rationale — direct/BYOK chats get a
 * real, always-current status every poll (this route can reach that
 * sandbox directly); default eve-path chats only reflect whatever the
 * agent's own get_preview_url/restart_sandbox tools last reported, since
 * nothing outside a live agent turn can reach eve's sandbox at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

type PreviewStatus = {
  status: string;
  available: boolean;
  url?: string | null;
  port?: number | null;
  reason?: string | null;
  error?: string | null;
  isDirect: boolean;
  requiresAgentAction: boolean;
};

export function ChatPreviewPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [state, setState] = useState<PreviewStatus | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/chats/${sessionId}/preview`);
      if (!res.ok) return;
      const data = (await res.json()) as PreviewStatus;
      setState(data);
    } catch {
      // Transient network error — next poll tick will retry, no need to
      // show a scary error for a single missed poll.
    }
  }, [sessionId]);

  useEffect(() => {
    poll();
    pollRef.current = setInterval(poll, 4000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [poll]);

  const restart = useCallback(async () => {
    setRestarting(true);
    try {
      const res = await fetch(`/api/chats/${sessionId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart' }),
      });
      const data = await res.json();
      if (data.requiresAgentAction) {
        setState(prev => (prev ? { ...prev, status: 'stopped', available: false, url: null, requiresAgentAction: true } : prev));
      } else {
        await poll();
      }
    } finally {
      setRestarting(false);
    }
  }, [sessionId, poll]);

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
              {state.status === 'error'
                ? state.error || 'Something went wrong starting the preview.'
                : state.requiresAgentAction
                  ? 'No dev server running yet.'
                  : 'Starting…'}
            </div>
            {state.requiresAgentAction && (
              <div className="text-xs text-muted-foreground max-w-xs">
                Ask the agent in chat to start (or restart) your app — e.g. "run the dev server" — and this panel will pick it up
                automatically.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
