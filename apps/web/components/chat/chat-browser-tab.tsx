'use client';

/**
 * "Browser" tab for ChatPreviewPanel (2026-07-16, explicit user request:
 * "I want the UI to actually display the live browser and I'm seeing
 * what it's doing realtime... make sure the browser displays well in
 * the UI"). Reads /api/chats/[sessionId]/browser-sessions, polling the
 * same gentle way ChatTerminalTab does -- so a browser_use tool call
 * started in one turn shows its live iframe here immediately, well
 * before that tool call itself finishes (see that route's file comment
 * for why: the DB row is written the moment the cloud session is
 * created).
 *
 * Renders every non-stopped session as its own live iframe (up to 3, one
 * per lane -- two Browser Use Cloud slots + one Steel slot -- so
 * genuinely parallel tasks are all visible at once), each with its own
 * manual Stop button (explicit user request: "the agent should be able
 * to stop the browser and start" -- this is the human side of that same
 * control). Recently-stopped/finished sessions are listed below,
 * collapsed, so the last outcome/summary is still visible after a
 * session ends instead of just disappearing.
 *
 * UPDATED (2026-07-17, "make the whole browser feature 3x better"):
 * added a live scrolling step/thought feed next to each iframe (fed by
 * browser_use.ts persisting `steps` incrementally during execution --
 * previously the panel showed nothing but raw video with zero insight
 * into what the agent was actually doing/thinking until the whole tool
 * call finished), a "Watch recording" link once a finished session has
 * one, and an elapsed-time readout. Poll interval tightened 4s -> 2s to
 * match the tool's own tighter poll cadence.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface StepEntry {
  role: string;
  summary: string;
  screenshotUrl: string | null;
  at: string;
}

interface BrowserSessionEntry {
  id: string;
  provider: string;
  slot: number;
  task: string;
  status: 'running' | 'idle' | 'stopped' | 'failed';
  liveUrl: string | null;
  output: string | null;
  isTaskSuccessful: boolean | null;
  steps: StepEntry[];
  recordingUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

function providerLabel(provider: string, slot: number): string {
  if (provider === 'steel') return 'Steel';
  if (provider === 'brightdata') return 'Bright Data';
  return `Browser Use (${slot})`;
}

function elapsedLabel(createdAt: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function StepFeed({ steps }: { steps: StepEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length]);

  if (steps.length === 0) {
    return <div className="px-2.5 py-2 text-[11px] text-muted-foreground italic">Waiting for the first step…</div>;
  }
  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-2.5 py-1.5 space-y-1 text-[11px] leading-snug">
      {steps.map((s, i) => {
        // System-level notices (stuck-loop detection, backup-model
        // rescue -- see browser_use.ts) are a genuinely different kind of
        // event from a normal action step: they're the tool recovering
        // from something going wrong mid-task, not just "here's what I
        // did next". Visually distinct (amber, bordered, its own icon) so
        // that's obvious at a glance in the live feed instead of blending
        // into the plain bullet list.
        if (s.role === 'system') {
          return (
            <div
              key={i}
              className="flex gap-1.5 items-start rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-1 text-amber-700 dark:text-amber-400"
            >
              <span className="shrink-0">⚠️</span>
              <span className="break-words">{s.summary}</span>
            </div>
          );
        }
        return (
          <div key={i} className="flex gap-1.5">
            <span className="text-muted-foreground shrink-0">{s.role === 'human' ? '👤' : '•'}</span>
            <span className="text-foreground/90 break-words">{s.summary}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ChatBrowserTab({ sessionId }: { sessionId: string }) {
  const [sessions, setSessions] = useState<BrowserSessionEntry[] | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [, forceTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/chats/${sessionId}/browser-sessions`);
      const data = await res.json();
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch {
      setSessions(prev => prev ?? []);
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
    // Live sessions can start/finish/add steps between agent turns --
    // poll gently so the tab reflects reality without a manual refresh.
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    // Re-render every second purely to keep the elapsed-time readout
    // ticking smoothly between refreshes -- doesn't touch the network.
    const t = setInterval(() => forceTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const stop = async (id: string) => {
    setStopping(id);
    try {
      await fetch(`/api/chats/${sessionId}/browser-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: id }),
      });
      await refresh();
    } finally {
      setStopping(null);
    }
  };

  const live = (sessions ?? []).filter(s => s.status === 'running' || s.status === 'idle');
  const ended = (sessions ?? []).filter(s => s.status === 'stopped' || s.status === 'failed');

  return (
    <div className="flex flex-col h-full bg-background">
      {sessions === null && <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Loading…</div>}

      {sessions !== null && live.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-center px-6 text-sm text-muted-foreground">
          No live browser right now. Ask the agent to browse something and it'll show up here in real time.
        </div>
      )}

      {live.length > 0 && (
        <div className="flex-1 min-h-0 overflow-auto p-3 grid gap-3" style={{ gridTemplateColumns: live.length > 1 ? 'repeat(auto-fit, minmax(340px, 1fr))' : '1fr' }}>
          {live.map(s => (
            <div key={s.id} className="border border-border rounded-lg overflow-hidden flex flex-col bg-card">
              <div className="px-2.5 py-1.5 border-b border-border/60 flex items-center justify-between gap-2 shrink-0">
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate flex items-center gap-1.5">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${s.status === 'running' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                    {providerLabel(s.provider, s.slot)}
                    <span className="text-muted-foreground font-normal">· {elapsedLabel(s.createdAt)}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate" title={s.task}>
                    {s.task}
                  </div>
                </div>
                <button
                  onClick={() => stop(s.id)}
                  disabled={stopping === s.id}
                  className="text-[11px] shrink-0 text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-accent disabled:opacity-50"
                >
                  {stopping === s.id ? 'Stopping…' : 'Stop'}
                </button>
              </div>
              <div className="flex-1 min-h-[220px] bg-black/90">
                {s.liveUrl ? (
                  <iframe
                    src={s.liveUrl}
                    className="w-full h-full border-0"
                    style={{ aspectRatio: '16/9' }}
                    allow="autoplay"
                    title={`Live browser — ${providerLabel(s.provider, s.slot)}`}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">Starting…</div>
                )}
              </div>
              <div className="border-t border-border/60 flex flex-col" style={{ maxHeight: 140 }}>
                <StepFeed steps={s.steps} />
              </div>
            </div>
          ))}
        </div>
      )}

      {ended.length > 0 && (
        <div className="border-t border-border/60 max-h-48 overflow-auto p-2 space-y-1.5 shrink-0">
          <div className="text-[11px] text-muted-foreground px-1">Recent</div>
          {ended.slice(0, 5).map(s => (
            <div key={s.id} className="text-xs px-2 py-1.5 rounded bg-muted/50">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">{providerLabel(s.provider, s.slot)}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {s.recordingUrl && (
                    <a href={s.recordingUrl} target="_blank" rel="noreferrer" className="text-[10px] text-blue-500 hover:underline">
                      Watch recording
                    </a>
                  )}
                  <span className={`text-[10px] ${s.isTaskSuccessful === false ? 'text-red-500' : 'text-muted-foreground'}`}>{s.status}</span>
                </div>
              </div>
              <div className="text-muted-foreground truncate" title={s.task}>
                {s.task}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
