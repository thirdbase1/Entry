'use client';

/**
 * "Terminal" tab for ChatPreviewPanel (2026-07-14, "full coding
 * environment" push -- explicit ask for visibility into long-running AI
 * tasks: what commands actually ran, not just chat prose describing them
 * after the fact). Reads /api/chats/[sessionId]/terminal, which pulls
 * every bash tool call straight out of the persisted chat events -- works
 * identically on both the direct/BYOK and eve-default chat paths, unlike
 * the Files/Preview tabs.
 */
import { useCallback, useEffect, useState } from 'react';

interface BashEntry {
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  status: 'running' | 'done' | 'error';
}

export function ChatTerminalTab({ sessionId }: { sessionId: string }) {
  const [entries, setEntries] = useState<BashEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/chats/${sessionId}/terminal`);
      const data = await res.json();
      setEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
    // Long-running tasks keep issuing new bash calls -- poll gently so
    // this tab stays live without the user having to manually refresh
    // mid-task, matching the "long-running AI tasks" visibility ask.
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="flex flex-col h-full bg-[#0d0d0d]">
      <div className="h-9 border-b border-border/50 px-3 flex items-center justify-between shrink-0">
        <span className="text-xs text-muted-foreground">{entries ? `${entries.length} command${entries.length === 1 ? '' : 's'}` : 'Terminal'}</span>
        <button onClick={refresh} disabled={loading} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-white/10 disabled:opacity-50">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <div className="flex-1 overflow-auto p-3 font-mono text-xs space-y-3">
        {entries === null && <div className="text-muted-foreground">Loading…</div>}
        {entries && entries.length === 0 && <div className="text-muted-foreground">No commands run yet in this chat.</div>}
        {entries?.map(entry => (
          <div key={entry.id} className="space-y-1">
            <div className="flex items-center gap-1.5 text-emerald-400">
              <span className="opacity-70">$</span>
              <span className="break-all">{entry.command}</span>
              {entry.status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />}
            </div>
            {entry.output && (
              <pre className={`whitespace-pre-wrap break-words pl-3 ${entry.status === 'error' || (entry.exitCode ?? 0) !== 0 ? 'text-red-400' : 'text-gray-300'}`}>
                {entry.output.slice(0, 4000)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
