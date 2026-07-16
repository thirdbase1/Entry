'use client';

/**
 * "History" tab (rewritten 2026-07-16, third iteration, after explicit
 * user correction: "No not GitHub versioning... our own custom
 * versioning, so when agent do something wrong I can revert to another
 * version". First version showed Vercel's raw deployment list (broke on
 * a misconfigured token). Second version showed raw GitHub commits with
 * manual git-revert + "ask your agent to deploy" (rejected outright).
 *
 * This is the actual custom system: plain-language "Versions" backed by
 * /api/admin/versions, an app-native table the agent writes to right
 * after every deploy -- no shas, no commit messages, no GitHub/Vercel
 * jargon anywhere in this UI. "Revert to this version" is fully
 * self-service and instant: click, confirm, it's live within seconds --
 * no agent needed, no rebuild wait.
 */
import { useCallback, useEffect, useState } from 'react';

type Version = {
  id: string;
  label: string;
  createdAt: string;
  isLive: boolean;
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ChatDeploymentsTab() {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [liveIdKnown, setLiveIdKnown] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/versions');
      const data = await res.json();
      if (data.error) setError(data.error);
      else {
        setError(null);
        setVersions(data.versions);
        setLiveIdKnown(data.liveIdKnown);
      }
    } catch {
      setError('Could not load version history — try again in a moment.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const revert = useCallback(
    async (id: string) => {
      setConfirmId(null);
      setRevertingId(id);
      setNotice(null);
      try {
        const res = await fetch('/api/admin/versions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revertToId: id }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setNotice(data.error || 'Revert failed.');
        } else {
          setNotice('Reverted — production is now live on that version.');
          await refresh();
        }
      } catch {
        setNotice('Revert failed — try again in a moment.');
      } finally {
        setRevertingId(null);
      }
    },
    [refresh]
  );

  return (
    <div className="flex flex-col h-full">
      <div className="h-9 border-b border-border px-3 flex items-center justify-between shrink-0">
        <span className="text-xs text-muted-foreground">{versions ? `${versions.length} versions` : 'Versions'}</span>
        <button onClick={refresh} disabled={loading} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent disabled:opacity-50">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {notice && (
        <div className="px-3 py-1.5 text-[11px] text-foreground bg-accent/60 border-b border-border shrink-0">{notice}</div>
      )}
      {versions && !liveIdKnown && (
        <div className="px-3 py-1.5 text-[11px] text-muted-foreground bg-accent/30 border-b border-border shrink-0">
          Can't tell which version is live right now — the list below is still accurate.
        </div>
      )}

      <div className="flex-1 overflow-auto py-2 px-3">
        {!versions && !error && <div className="text-xs text-muted-foreground py-2">Loading…</div>}
        {error && <div className="text-xs text-muted-foreground py-2">{error}</div>}
        {versions && versions.length === 0 && (
          <div className="text-xs text-muted-foreground py-2">No versions recorded yet — one gets saved automatically each time a change ships.</div>
        )}

        {versions && versions.length > 0 && (
          <div className="relative">
            {/* vertical timeline spine */}
            <div className="absolute top-1 bottom-1 left-[5px] w-px bg-border" />
            {versions.map(v => (
              <div key={v.id} className="group relative pl-5 pb-4 last:pb-0">
                <span
                  className={`absolute left-0 top-1 w-[11px] h-[11px] rounded-full border-2 ${
                    v.isLive ? 'bg-emerald-500 border-emerald-500' : 'bg-background border-border'
                  }`}
                />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-medium text-foreground break-words">{v.label}</span>
                      {v.isLive && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">Live</span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">{timeAgo(v.createdAt)}</div>
                  </div>
                  {!v.isLive && (
                    <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      {confirmId === v.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => revert(v.id)}
                            disabled={revertingId === v.id}
                            className="text-[11px] px-2 py-0.5 rounded bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 disabled:opacity-50"
                          >
                            {revertingId === v.id ? 'Reverting…' : 'Confirm revert'}
                          </button>
                          <button onClick={() => setConfirmId(null)} className="text-[11px] px-2 py-0.5 rounded hover:bg-accent text-muted-foreground">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmId(v.id)}
                          className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent text-muted-foreground hover:text-foreground"
                        >
                          Revert to this version
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
