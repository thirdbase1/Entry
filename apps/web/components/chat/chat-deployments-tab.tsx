'use client';

/**
 * "History" tab (2026-07-15, explicit user request: "agent work
 * versioning... connect it well so user can revert any time to any
 * Vercel [deployment]... let your best idea win on how to do it on the
 * UI"). Backed by /api/admin/deployments, which wraps Vercel's own
 * deployment history + Instant Rollback — see that route's file comment
 * for why this rides on Vercel's real mechanism instead of a parallel
 * home-grown versioning system.
 *
 * UI idea: a vertical timeline (like a git log / commit history you'd
 * see in a real IDE's source control view) rather than a flat table —
 * each entry is a dot-on-a-line with the commit message as the primary
 * label (what actually changed, in the user's own words) and everything
 * else (time, short sha, branch) as secondary metadata. The CURRENT live
 * production deployment gets a solid highlighted dot + a "Live" badge so
 * it's unambiguous what reverting would move away from. Every other
 * entry reveals a "Revert to this" button on hover; clicking asks for one
 * explicit confirmation (this repoints production for every visitor,
 * worth one extra click) then calls the rollback endpoint and refreshes.
 */
import { useCallback, useEffect, useState } from 'react';

type Deployment = {
  id: string;
  url: string;
  state: string;
  createdAt: number;
  isCurrent: boolean;
  commitMessage: string | null;
  commitSha: string | null;
  branch: string | null;
  creator: string | null;
};

function timeAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function StateBadge({ state, isCurrent }: { state: string; isCurrent: boolean }) {
  if (isCurrent) {
    return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">Live</span>;
  }
  if (state === 'ERROR') {
    return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-600 dark:text-red-400">Failed</span>;
  }
  if (state === 'BUILDING' || state === 'QUEUED' || state === 'INITIALIZING') {
    return <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">Building</span>;
  }
  return null;
}

export function ChatDeploymentsTab() {
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/deployments');
      const data = await res.json();
      if (data.error) setError(data.error);
      else {
        setError(null);
        setDeployments(data.deployments);
      }
    } catch {
      setError('Could not load deployment history — try again in a moment.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const rollback = useCallback(
    async (id: string) => {
      setConfirmId(null);
      setRollingBackId(id);
      setNotice(null);
      try {
        const res = await fetch('/api/admin/deployments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deploymentId: id }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setNotice(data.error || 'Rollback failed.');
        } else {
          setNotice('Reverted — production is now serving that deployment.');
          await refresh();
        }
      } catch {
        setNotice('Rollback failed — try again in a moment.');
      } finally {
        setRollingBackId(null);
      }
    },
    [refresh]
  );

  return (
    <div className="flex flex-col h-full">
      <div className="h-9 border-b border-border px-3 flex items-center justify-between shrink-0">
        <span className="text-xs text-muted-foreground">{deployments ? `${deployments.length} deployments` : 'History'}</span>
        <button onClick={refresh} disabled={loading} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent disabled:opacity-50">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {notice && (
        <div className="px-3 py-1.5 text-[11px] text-foreground bg-accent/60 border-b border-border shrink-0">{notice}</div>
      )}

      <div className="flex-1 overflow-auto py-2 px-3">
        {!deployments && !error && <div className="text-xs text-muted-foreground py-2">Loading…</div>}
        {error && <div className="text-xs text-muted-foreground py-2">{error}</div>}

        {deployments && (
          <div className="relative">
            {/* vertical timeline spine */}
            <div className="absolute top-1 bottom-1 left-[5px] w-px bg-border" />
            {deployments.map(d => (
              <div key={d.id} className="group relative pl-5 pb-4 last:pb-0">
                <span
                  className={`absolute left-0 top-1 w-[11px] h-[11px] rounded-full border-2 ${
                    d.isCurrent
                      ? 'bg-emerald-500 border-emerald-500'
                      : d.state === 'ERROR'
                        ? 'bg-background border-red-500'
                        : 'bg-background border-border'
                  }`}
                />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{d.commitMessage || '(no commit message)'}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                      <StateBadge state={d.state} isCurrent={d.isCurrent} />
                      <span>{timeAgo(d.createdAt)}</span>
                      {d.commitSha && <span className="font-mono">{d.commitSha}</span>}
                      {d.branch && <span>{d.branch}</span>}
                      {d.creator && <span>by {d.creator}</span>}
                    </div>
                  </div>

                  {!d.isCurrent && d.state === 'READY' && (
                    <div className="shrink-0">
                      {confirmId === d.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => rollback(d.id)}
                            disabled={rollingBackId === d.id}
                            className="text-[11px] font-medium px-2 py-1 rounded bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 disabled:opacity-50"
                          >
                            {rollingBackId === d.id ? 'Reverting…' : 'Confirm revert'}
                          </button>
                          <button onClick={() => setConfirmId(null)} className="text-[11px] text-muted-foreground px-2 py-1 rounded hover:bg-accent">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmId(d.id)}
                          className="text-[11px] px-2 py-1 rounded border border-border opacity-0 group-hover:opacity-100 hover:bg-accent transition-opacity"
                        >
                          Revert to this
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
