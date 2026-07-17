'use client';

/**
 * The chat side panel's "History" tab — CHANGED (2026-07-16, explicit
 * user correction: "Change that history page that show wide deployment
 * history To the each chat versioning"). Previously rendered
 * ChatDeploymentsTab, a site-wide production-deployment rollback browser
 * (AppVersion / Vercel Instant Rollback — see that model's schema
 * comment) which is a real but totally separate, unrelated concept to a
 * single chat's own file history. That system is untouched and still
 * exists for actual prod-ops use; it just doesn't belong inside a single
 * chat's own panel, where a user has no mental model for "production
 * deployment" at all — only "this conversation's project."
 *
 * This renders THIS chat's own per-turn file version history instead
 * (packages/db/src/chat-versioning.ts / /api/chats/[id]/versions/*):
 * one entry per agent turn that changed >=1 file, expandable to the
 * exact files changed (+/- per file), expandable again to a real
 * line-by-line diff, and (for BYOK/direct chats, where a live sandbox is
 * directly reachable) an instant one-click Revert. Same version-card
 * feed a user already sees inline in the chat itself
 * (renderers/version-card.tsx) — this tab is just the full, browsable
 * history of it, one level deeper.
 *
 * UPGRADED (2026-07-17, "improve history and versioning" push, six
 * concrete gaps closed):
 *  1. Live polling (matches the Files/Preview tabs' already-established
 *     pattern) instead of only ever refreshing on mount/manual click --
 *     a version created by the agent mid-session used to just not show
 *     up here until someone remembered to hit Refresh.
 *  2. A real search box, server-backed (route.ts's `?q=`) so it finds
 *     matches beyond whatever page happens to be currently loaded, not
 *     just a client-side filter over it.
 *  3. Actual "Load older" pagination via the `?before=` cursor -- the
 *     list used to hard-cap at a flat 200 with zero way to reach
 *     anything past that.
 *  4. Rename: a version's auto-generated summary can now be edited into
 *     a real milestone label.
 *  5. Per-file revert ("Revert this file" on each row inside an expanded
 *     version) alongside the existing whole-version Revert -- rolling
 *     back one bad file used to mean losing every other file's progress
 *     back to that point too.
 *  6. Per-version "Download" -- grabs that exact snapshot as a .tar.gz,
 *     works on every chat type since it's pure-DB (no sandbox needed).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Diff from 'diff';
import { HistoryIcon, UndoIcon, ExpandIcon, PlusIcon, DeleteIcon, EditIcon } from '@blocksuite/icons/rc';

interface VersionListItem {
  versionNumber: number;
  summary: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  revertedFromVersionNumber: number | null;
  createdAt: string;
  isHead: boolean;
}

interface VersionFile {
  path: string;
  changeType: 'added' | 'modified' | 'deleted';
  linesAdded: number;
  linesRemoved: number;
}

interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function changeTypeIcon(t: VersionFile['changeType']) {
  if (t === 'added') return <PlusIcon className="size-3 text-emerald-500 shrink-0" />;
  if (t === 'deleted') return <DeleteIcon className="size-3 text-red-500 shrink-0" />;
  return <EditIcon className="size-3 text-amber-500 shrink-0" />;
}

function DiffView({ before, after }: { before: string | null; after: string | null }) {
  const parts: DiffPart[] = before == null && after == null ? [] : Diff.diffLines(before ?? '', after ?? '');
  return (
    <div className="mt-1.5 rounded-md bg-muted/40 border border-border overflow-auto max-h-64 font-mono text-[11px] leading-5">
      {parts.map((part, i) => {
        const lines = part.value.replace(/\n$/, '').split('\n');
        const bg = part.added ? 'bg-emerald-500/10' : part.removed ? 'bg-red-500/10' : '';
        const prefix = part.added ? '+' : part.removed ? '-' : ' ';
        const color = part.added ? 'text-emerald-700 dark:text-emerald-400' : part.removed ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground';
        return lines.map((line, j) => (
          <div key={`${i}-${j}`} className={`px-2 whitespace-pre ${bg} ${color}`}>
            {prefix} {line}
          </div>
        ));
      })}
      {parts.length === 0 && <div className="px-2 py-1 text-muted-foreground">No content to diff.</div>}
    </div>
  );
}

function FileRow({
  sessionId,
  versionNumber,
  file,
  canRevertLive,
  onFileReverted,
}: {
  sessionId: string;
  versionNumber: number;
  file: VersionFile;
  canRevertLive: boolean;
  onFileReverted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<{ before: string | null; after: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!diff) {
      setLoading(true);
      try {
        const res = await fetch(`/api/chats/${sessionId}/versions/${versionNumber}/diff?path=${encodeURIComponent(file.path)}`);
        const data = await res.json();
        if (!data.error) setDiff({ before: data.before ?? null, after: data.after ?? null });
      } finally {
        setLoading(false);
      }
    }
  }, [open, diff, sessionId, versionNumber, file.path]);

  // Per-file revert (2026-07-17) -- restores just this one path to its
  // content as of `versionNumber`, leaving every other file (including
  // ones from later versions) untouched. See revert-file/route.ts.
  const doRevertFile = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmRevert(false);
    setReverting(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/chats/${sessionId}/versions/${versionNumber}/revert-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.path }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setNotice(data.error || 'Revert failed.');
      } else {
        setNotice(`Restored — now on Version #${data.versionNumber}.`);
        onFileReverted();
      }
    } catch {
      setNotice('Revert failed — try again in a moment.');
    } finally {
      setReverting(false);
    }
  }, [sessionId, versionNumber, file.path, onFileReverted]);

  return (
    <div className="border-t border-border/60 first:border-t-0 group/file">
      <div className="flex items-center gap-1.5 py-1.5">
        <button onClick={toggle} className="flex-1 min-w-0 flex items-center gap-1.5 text-left hover:bg-accent/40 rounded-sm px-1 -mx-1">
          {changeTypeIcon(file.changeType)}
          <span className="text-[11px] font-mono truncate flex-1">{file.path}</span>
          {file.linesAdded > 0 && <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400">+{file.linesAdded}</span>}
          {file.linesRemoved > 0 && <span className="text-[10px] font-mono text-red-600 dark:text-red-400">-{file.linesRemoved}</span>}
          <ExpandIcon className={`size-3 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
        {canRevertLive && !reverting && !confirmRevert && (
          <button
            onClick={e => {
              e.stopPropagation();
              setConfirmRevert(true);
            }}
            className="shrink-0 opacity-0 group-hover/file:opacity-100 transition-opacity text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent"
            title="Revert just this file to this version"
          >
            Revert
          </button>
        )}
        {confirmRevert && (
          <div className="shrink-0 flex items-center gap-1">
            <button onClick={doRevertFile} className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25">
              Confirm
            </button>
            <button onClick={e => { e.stopPropagation(); setConfirmRevert(false); }} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-accent text-muted-foreground">
              Cancel
            </button>
          </div>
        )}
        {reverting && <span className="shrink-0 text-[10px] text-muted-foreground">Reverting…</span>}
      </div>
      {notice && <div className="text-[10px] text-muted-foreground pb-1 px-1">{notice}</div>}
      {open && (loading ? <div className="text-[11px] text-muted-foreground py-1 px-1">Loading diff…</div> : diff && <DiffView before={diff.before} after={diff.after} />)}
    </div>
  );
}

function VersionEntry({
  sessionId,
  version,
  canRevertLive,
  onReverted,
}: {
  sessionId: string;
  version: VersionListItem;
  canRevertLive: boolean;
  onReverted: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<VersionFile[] | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(version.summary);
  const [savingName, setSavingName] = useState(false);
  const [summary, setSummary] = useState(version.summary);
  const [zipping, setZipping] = useState(false);

  const toggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!files) {
      setLoadingFiles(true);
      try {
        const res = await fetch(`/api/chats/${sessionId}/versions/${version.versionNumber}`);
        const data = await res.json();
        if (!data.error) setFiles(data.files);
      } finally {
        setLoadingFiles(false);
      }
    }
  }, [expanded, files, sessionId, version.versionNumber]);

  const doRevert = useCallback(async () => {
    setConfirmRevert(false);
    setReverting(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/chats/${sessionId}/versions/${version.versionNumber}/revert`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) {
        setNotice(data.error || 'Revert failed.');
      } else {
        setNotice(`Reverted — now on Version #${data.versionNumber}.`);
        onReverted();
      }
    } catch {
      setNotice('Revert failed — try again in a moment.');
    } finally {
      setReverting(false);
    }
  }, [sessionId, version.versionNumber, onReverted]);

  // Rename (2026-07-17) -- edits the summary/label in place via the
  // list route's own PATCH. Local `summary` state overrides the prop so
  // the new label shows immediately without waiting on a full refetch.
  const saveRename = useCallback(async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === summary) {
      setRenaming(false);
      setNameDraft(summary);
      return;
    }
    setSavingName(true);
    try {
      const res = await fetch(`/api/chats/${sessionId}/versions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionNumber: version.versionNumber, summary: trimmed }),
      });
      const data = await res.json();
      if (res.ok && !data.error) {
        setSummary(trimmed);
        setRenaming(false);
      } else {
        setNotice(data.error || 'Could not rename this version.');
      }
    } catch {
      setNotice('Could not rename this version — try again in a moment.');
    } finally {
      setSavingName(false);
    }
  }, [sessionId, version.versionNumber, nameDraft, summary]);

  // Download this exact snapshot (2026-07-17) -- see zip/route.ts.
  const downloadSnapshot = useCallback(async () => {
    setZipping(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/chats/${sessionId}/versions/${version.versionNumber}/zip`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setNotice(data?.error || 'Could not create the snapshot download.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `version-${version.versionNumber}-${sessionId.slice(0, 8)}.tar.gz`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setNotice('Could not create the snapshot download — try again in a moment.');
    } finally {
      setZipping(false);
    }
  }, [sessionId, version.versionNumber]);

  const isRevert = version.revertedFromVersionNumber != null;

  return (
    <div className="group relative pl-5 pb-4 last:pb-0">
      <span
        className={`absolute left-0 top-1 w-[11px] h-[11px] rounded-full border-2 ${
          version.isHead ? 'bg-emerald-500 border-emerald-500' : 'bg-background border-border'
        }`}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-left flex-1">
          <button onClick={toggle} className="w-full text-left">
            <div className="flex items-center gap-1.5 flex-wrap">
              {isRevert ? <UndoIcon className="size-3 text-amber-500 shrink-0" /> : <HistoryIcon className="size-3 text-muted-foreground shrink-0" />}
              <span className="text-xs font-medium text-foreground">Version #{version.versionNumber}</span>
              {isRevert && <span className="text-[11px] text-amber-600 dark:text-amber-400">Reverted from v{version.revertedFromVersionNumber}</span>}
              {version.isHead && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">Live</span>}
            </div>
          </button>
          {renaming ? (
            <div className="flex items-center gap-1 mt-0.5" onClick={e => e.stopPropagation()}>
              <input
                autoFocus
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') saveRename();
                  if (e.key === 'Escape') { setRenaming(false); setNameDraft(summary); }
                }}
                className="flex-1 text-[11px] px-1.5 py-0.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              <button onClick={saveRename} disabled={savingName} className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-50">
                {savingName ? '…' : 'Save'}
              </button>
              <button onClick={() => { setRenaming(false); setNameDraft(summary); }} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-accent text-muted-foreground">
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setRenaming(true)}
              className="text-[11px] text-muted-foreground mt-0.5 truncate block text-left hover:text-foreground w-full"
              title="Click to rename this version"
            >
              {summary}
            </button>
          )}
          <button onClick={toggle} className="w-full text-left">
            <div className="flex items-center gap-2 mt-1 text-[11px]">
              <span className="text-muted-foreground">{timeAgo(version.createdAt)}</span>
              <span className="text-muted-foreground">· {version.filesChanged} file{version.filesChanged === 1 ? '' : 's'}</span>
              {version.linesAdded > 0 && <span className="font-mono text-emerald-600 dark:text-emerald-400">+{version.linesAdded}</span>}
              {version.linesRemoved > 0 && <span className="font-mono text-red-600 dark:text-red-400">-{version.linesRemoved}</span>}
            </div>
          </button>
        </div>

        <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={downloadSnapshot}
            disabled={zipping}
            className="text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50"
            title="Download this version's full snapshot"
          >
            {zipping ? '…' : 'Download'}
          </button>
          {!version.isHead && canRevertLive && (
            confirmRevert ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={doRevert}
                  disabled={reverting}
                  className="text-[11px] px-2 py-0.5 rounded bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 disabled:opacity-50"
                >
                  {reverting ? 'Reverting…' : 'Confirm'}
                </button>
                <button onClick={() => setConfirmRevert(false)} className="text-[11px] px-2 py-0.5 rounded hover:bg-accent text-muted-foreground">
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmRevert(true)}
                className="text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent"
              >
                Revert
              </button>
            )
          )}
        </div>
      </div>

      {notice && <div className="text-[11px] text-muted-foreground mt-1">{notice}</div>}

      {expanded && (
        <div className="mt-2 pl-1">
          {loadingFiles && <div className="text-[11px] text-muted-foreground py-1">Loading files…</div>}
          {files && files.map(f => (
            <FileRow
              key={f.path}
              sessionId={sessionId}
              versionNumber={version.versionNumber}
              file={f}
              canRevertLive={canRevertLive}
              onFileReverted={onReverted}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const POLL_INTERVAL_MS = 5000;

export function ChatVersionsTab({ sessionId }: { sessionId: string }) {
  const [versions, setVersions] = useState<VersionListItem[] | null>(null);
  const [canRevertLive, setCanRevertLive] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  // Debounced value actually sent to the server -- avoids firing a
  // request on every keystroke while typing a search term.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const anyActionInFlightRef = useRef(false);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const refresh = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
    try {
      const qs = debouncedSearch ? `?q=${encodeURIComponent(debouncedSearch)}` : '';
      const res = await fetch(`/api/chats/${sessionId}/versions${qs}`);
      const data = await res.json();
      if (data.error) setError(data.error);
      else {
        setError(null);
        setVersions(data.versions);
        setCanRevertLive(Boolean(data.canRevertLive));
        setHasMore(Boolean(data.hasMore));
      }
    } catch {
      if (!opts.silent) setError('Could not load version history — try again in a moment.');
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, [sessionId, debouncedSearch]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live polling (2026-07-17) -- same pattern already established for
  // the Files/Preview tabs: keep the list current while it's actually
  // being looked at, silently (no loading-spinner flicker).
  useEffect(() => {
    const interval = setInterval(() => {
      if (anyActionInFlightRef.current) return;
      refresh({ silent: true });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!versions || versions.length === 0) return;
    setLoadingMore(true);
    try {
      const oldest = versions[versions.length - 1].versionNumber;
      const qs = debouncedSearch ? `&q=${encodeURIComponent(debouncedSearch)}` : '';
      const res = await fetch(`/api/chats/${sessionId}/versions?before=${oldest}${qs}`);
      const data = await res.json();
      if (!data.error) {
        setVersions(prev => [...(prev ?? []), ...data.versions]);
        setHasMore(Boolean(data.hasMore));
      }
    } finally {
      setLoadingMore(false);
    }
  }, [sessionId, versions, debouncedSearch]);

  return (
    <div className="flex flex-col h-full">
      <div className="h-9 border-b border-border px-3 flex items-center justify-between shrink-0">
        <span className="text-xs text-muted-foreground">{versions ? `${versions.length}${hasMore ? '+' : ''} version${versions.length === 1 ? '' : 's'}` : 'Versions'}</span>
        <button onClick={() => refresh()} disabled={loading} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent disabled:opacity-50">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="px-2 pt-1.5 pb-1 shrink-0 border-b border-border">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search versions by label or number…"
          className="w-full text-xs px-2 py-1 rounded-md border border-border bg-background placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
      </div>

      {versions && !canRevertLive && (
        <div className="px-3 py-1.5 text-[11px] text-muted-foreground bg-accent/30 border-b border-border shrink-0">
          Revert isn't available for this chat type yet — browsing history and downloading snapshots still work.
        </div>
      )}

      <div className="flex-1 overflow-auto py-2 px-3">
        {!versions && !error && <div className="text-xs text-muted-foreground py-2">Loading…</div>}
        {error && <div className="text-xs text-muted-foreground py-2">{error}</div>}
        {versions && versions.length === 0 && !debouncedSearch && (
          <div className="text-xs text-muted-foreground py-2">No versions yet — one gets saved automatically the first time the agent changes a file here.</div>
        )}
        {versions && versions.length === 0 && debouncedSearch && (
          <div className="text-xs text-muted-foreground py-2">No versions match "{debouncedSearch}".</div>
        )}

        {versions && versions.length > 0 && (
          <div className="relative">
            <div className="absolute top-1 bottom-1 left-[5px] w-px bg-border" />
            {versions.map(v => (
              <VersionEntry
                key={v.versionNumber}
                sessionId={sessionId}
                version={v}
                canRevertLive={canRevertLive}
                onReverted={() => refresh()}
              />
            ))}
          </div>
        )}

        {hasMore && (
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="w-full mt-1 text-xs text-muted-foreground hover:text-foreground py-1.5 rounded hover:bg-accent disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load older versions'}
          </button>
        )}
      </div>
    </div>
  );
}
