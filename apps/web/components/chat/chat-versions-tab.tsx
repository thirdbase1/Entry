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
 */
import { useCallback, useEffect, useState } from 'react';
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

function FileRow({ sessionId, versionNumber, file }: { sessionId: string; versionNumber: number; file: VersionFile }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<{ before: string | null; after: string | null } | null>(null);
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="border-t border-border/60 first:border-t-0">
      <button onClick={toggle} className="w-full flex items-center gap-1.5 py-1.5 text-left hover:bg-accent/40 rounded-sm px-1 -mx-1">
        {changeTypeIcon(file.changeType)}
        <span className="text-[11px] font-mono truncate flex-1">{file.path}</span>
        {file.linesAdded > 0 && <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400">+{file.linesAdded}</span>}
        {file.linesRemoved > 0 && <span className="text-[10px] font-mono text-red-600 dark:text-red-400">-{file.linesRemoved}</span>}
        <ExpandIcon className={`size-3 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
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

  const isRevert = version.revertedFromVersionNumber != null;

  return (
    <div className="group relative pl-5 pb-4 last:pb-0">
      <span
        className={`absolute left-0 top-1 w-[11px] h-[11px] rounded-full border-2 ${
          version.isHead ? 'bg-emerald-500 border-emerald-500' : 'bg-background border-border'
        }`}
      />
      <div className="flex items-start justify-between gap-2">
        <button onClick={toggle} className="min-w-0 text-left flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            {isRevert ? <UndoIcon className="size-3 text-amber-500 shrink-0" /> : <HistoryIcon className="size-3 text-muted-foreground shrink-0" />}
            <span className="text-xs font-medium text-foreground">Version #{version.versionNumber}</span>
            {isRevert && <span className="text-[11px] text-amber-600 dark:text-amber-400">Reverted from v{version.revertedFromVersionNumber}</span>}
            {version.isHead && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">Live</span>}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{version.summary}</div>
          <div className="flex items-center gap-2 mt-1 text-[11px]">
            <span className="text-muted-foreground">{timeAgo(version.createdAt)}</span>
            <span className="text-muted-foreground">· {version.filesChanged} file{version.filesChanged === 1 ? '' : 's'}</span>
            {version.linesAdded > 0 && <span className="font-mono text-emerald-600 dark:text-emerald-400">+{version.linesAdded}</span>}
            {version.linesRemoved > 0 && <span className="font-mono text-red-600 dark:text-red-400">-{version.linesRemoved}</span>}
          </div>
        </button>

        {!version.isHead && canRevertLive && (
          <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            {confirmRevert ? (
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
                className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent text-muted-foreground hover:text-foreground"
              >
                Revert
              </button>
            )}
          </div>
        )}
      </div>

      {notice && <div className="mt-1 text-[11px] text-muted-foreground">{notice}</div>}

      {expanded && (
        <div className="mt-2 pl-0.5">
          {loadingFiles && <div className="text-[11px] text-muted-foreground py-1">Loading files…</div>}
          {files && files.length === 0 && <div className="text-[11px] text-muted-foreground py-1">No files recorded for this version.</div>}
          {files && files.map(f => <FileRow key={f.path} sessionId={sessionId} versionNumber={version.versionNumber} file={f} />)}
        </div>
      )}
    </div>
  );
}

export function ChatVersionsTab({ sessionId }: { sessionId: string }) {
  const [versions, setVersions] = useState<VersionListItem[] | null>(null);
  const [canRevertLive, setCanRevertLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/chats/${sessionId}/versions`);
      const data = await res.json();
      if (data.error) setError(data.error);
      else {
        setError(null);
        setVersions(data.versions);
        setCanRevertLive(Boolean(data.canRevertLive));
      }
    } catch {
      setError('Could not load version history — try again in a moment.');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col h-full">
      <div className="h-9 border-b border-border px-3 flex items-center justify-between shrink-0">
        <span className="text-xs text-muted-foreground">{versions ? `${versions.length} version${versions.length === 1 ? '' : 's'}` : 'Versions'}</span>
        <button onClick={refresh} disabled={loading} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent disabled:opacity-50">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {versions && !canRevertLive && (
        <div className="px-3 py-1.5 text-[11px] text-muted-foreground bg-accent/30 border-b border-border shrink-0">
          Revert isn't available for this chat type yet — browsing history still works.
        </div>
      )}

      <div className="flex-1 overflow-auto py-2 px-3">
        {!versions && !error && <div className="text-xs text-muted-foreground py-2">Loading…</div>}
        {error && <div className="text-xs text-muted-foreground py-2">{error}</div>}
        {versions && versions.length === 0 && (
          <div className="text-xs text-muted-foreground py-2">No versions yet — one gets saved automatically the first time the agent changes a file here.</div>
        )}

        {versions && versions.length > 0 && (
          <div className="relative">
            <div className="absolute top-1 bottom-1 left-[5px] w-px bg-border" />
            {versions.map(v => (
              <VersionEntry key={v.versionNumber} sessionId={sessionId} version={v} canRevertLive={canRevertLive} onReverted={refresh} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
