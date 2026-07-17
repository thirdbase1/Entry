'use client';

/**
 * "Files" tab content for ChatPreviewPanel (2026-07-13, explicit user
 * request: a visible file tree for what the agent's sandbox is working
 * on, not just the running preview). See /api/chats/[sessionId]/files
 * for the two-path split rationale (direct/BYOK: live sandbox read;
 * eve-default path: whatever `list_files` last wrote).
 *
 * Upgraded (2026-07-14, "full coding environment" push): file content now
 * renders in the real Monaco editor (CodeEditor) instead of a plain
 * `<pre>` dump, with syntax highlighting and, on the direct/BYOK path
 * (the only one with a live sandbox handle to write back to), inline
 * editing + save via PUT /api/chats/[sessionId]/files. The eve-default
 * path stays read-only -- same reason it was already read-only for
 * viewing before this change.
 *
 * Polls on the same cadence as the preview status (while the tree view is
 * showing, not the file-content editor -- no point refetching the whole
 * tree while someone's actively reading/editing one open file), so it
 * tracks the live sandbox instead of a frozen snapshot of it.
 *
 * REDESIGNED (2026-07-15, explicit user report: "file tree showing me
 * file size too large" + "improve the file tree to look more better and
 * advanced"): paired with the API route no longer hard-blocking on size,
 * the tree itself now looks like a real IDE explorer instead of a plain
 * emoji list -- extension-aware icons, per-row file size, rotating
 * chevrons instead of swapping folder emoji, vertical indent guides for
 * nesting depth, and a visible (not silently-failing) truncation banner
 * when a file got capped instead of a flat "too large" refusal.
 */
import { useCallback, useEffect, useState } from 'react';
import { CodeEditor } from './code-editor';

type Entry = { path: string; type: 'file' | 'dir'; size?: number };
type TreeNode = { name: string; path: string; type: 'file' | 'dir'; size?: number; children: Map<string, TreeNode> };

function buildTree(entries: Entry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: new Map() };
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const parts = entry.path.split('/').filter(Boolean);
    let cursor = root;
    parts.forEach((part, idx) => {
      const isLast = idx === parts.length - 1;
      if (!cursor.children.has(part)) {
        cursor.children.set(part, {
          name: part,
          path: parts.slice(0, idx + 1).join('/'),
          type: isLast ? entry.type : 'dir',
          size: isLast ? entry.size : undefined,
          children: new Map(),
        });
      }
      cursor = cursor.children.get(part)!;
    });
  }
  return root;
}

// Folders sort before files, then alphabetical -- standard IDE ordering,
// nicer to scan than the flat path-sort the raw entries come in as.
function sortedChildren(node: TreeNode): TreeNode[] {
  return Array.from(node.children.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Small, dependency-free extension -> {icon, color} map. Not trying to
// cover every possible extension, just enough that a real project's tree
// visibly differentiates code / config / docs / images / data instead of
// one flat file icon for everything.
const EXT_STYLE: Record<string, { icon: string; color: string }> = {
  ts: { icon: 'TS', color: '#3b82f6' },
  tsx: { icon: 'TX', color: '#3b82f6' },
  js: { icon: 'JS', color: '#eab308' },
  jsx: { icon: 'JX', color: '#eab308' },
  mjs: { icon: 'JS', color: '#eab308' },
  json: { icon: '{}', color: '#f97316' },
  jsonc: { icon: '{}', color: '#f97316' },
  md: { icon: '#', color: '#94a3b8' },
  mdx: { icon: '#', color: '#94a3b8' },
  css: { icon: '#', color: '#a855f7' },
  scss: { icon: '#', color: '#a855f7' },
  html: { icon: '<>', color: '#f97316' },
  py: { icon: 'PY', color: '#22c55e' },
  rs: { icon: 'RS', color: '#f97316' },
  go: { icon: 'GO', color: '#38bdf8' },
  sql: { icon: 'DB', color: '#38bdf8' },
  prisma: { icon: 'DB', color: '#38bdf8' },
  env: { icon: 'ENV', color: '#22c55e' },
  yml: { icon: 'YML', color: '#94a3b8' },
  yaml: { icon: 'YML', color: '#94a3b8' },
  toml: { icon: 'TOML', color: '#94a3b8' },
  lock: { icon: 'LOCK', color: '#64748b' },
  sh: { icon: '$_', color: '#22c55e' },
  png: { icon: 'IMG', color: '#ec4899' },
  jpg: { icon: 'IMG', color: '#ec4899' },
  jpeg: { icon: 'IMG', color: '#ec4899' },
  svg: { icon: 'IMG', color: '#ec4899' },
  gif: { icon: 'IMG', color: '#ec4899' },
  ico: { icon: 'IMG', color: '#ec4899' },
};

function FileIcon({ name }: { name: string }) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const style = EXT_STYLE[ext];
  if (!style) {
    return <span className="inline-flex items-center justify-center w-4 h-4 shrink-0 text-[8px] font-bold rounded-sm text-muted-foreground/70 border border-current/20">•</span>;
  }
  return (
    <span
      className="inline-flex items-center justify-center w-4 h-4 shrink-0 text-[7px] font-bold rounded-sm leading-none"
      style={{ color: style.color, backgroundColor: `${style.color}1a` }}
    >
      {style.icon.length > 2 ? style.icon.slice(0, 2) : style.icon}
    </span>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="w-3 h-3 shrink-0 text-muted-foreground/60 transition-transform duration-150"
      style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
      fill="none"
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TreeRow({
  node,
  depth,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  onOpenFile: (path: string) => void;
}) {
  // Root-level dirs start open; deeper ones start collapsed so a real
  // project doesn't dump hundreds of expanded rows on first render.
  const [open, setOpen] = useState(depth < 1);
  const children = sortedChildren(node);
  const indentGuides = Array.from({ length: depth });

  if (node.type === 'file') {
    return (
      <button
        onClick={() => onOpenFile(node.path)}
        className="group relative w-full text-left text-[12.5px] pr-2 py-[3px] flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-sm"
        style={{ paddingLeft: `${depth * 14 + 20}px` }}
        title={node.path}
      >
        {indentGuides.map((_, i) => (
          <span key={i} className="absolute top-0 bottom-0 w-px bg-border/60" style={{ left: `${i * 14 + 14}px` }} />
        ))}
        <FileIcon name={node.name} />
        <span className="truncate flex-1">{node.name}</span>
        {node.size != null && <span className="text-[10px] tabular-nums text-muted-foreground/50 opacity-0 group-hover:opacity-100 shrink-0">{formatSize(node.size)}</span>}
      </button>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="group relative w-full text-left text-[12.5px] pr-2 py-[3px] flex items-center gap-1 font-medium hover:bg-accent/60 rounded-sm"
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {indentGuides.map((_, i) => (
          <span key={i} className="absolute top-0 bottom-0 w-px bg-border/60" style={{ left: `${i * 14 + 14}px` }} />
        ))}
        <ChevronIcon open={open} />
        <span className="truncate">{node.name || '/'}</span>
      </button>
      {open && (
        <div className="animate-in fade-in slide-in-from-top-0.5 duration-100">
          {children.map(child => (
            <TreeRow key={child.path} node={child} depth={depth + 1} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatFilesTab({ sessionId }: { sessionId: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isDirect, setIsDirect] = useState(false);
  const [openFile, setOpenFile] = useState<{ path: string; content?: string; error?: string; loading: boolean; truncatedNotice?: string } | null>(null);
  // Search/filter box (2026-07-17, "improve files" push) -- a real project
  // tree can run hundreds of files deep; scanning-by-eye for one file was
  // the only option before. Filters by substring match against the full
  // path (not just the filename) so e.g. typing "route" surfaces every
  // route.ts across the whole app tree, not just top-level matches.
  const [search, setSearch] = useState('');
  // Whole-project download (2026-07-17) -- direct/BYOK only, same reason
  // editing already is: only that path has a live sandbox to archive.
  const [zipping, setZipping] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/chats/${sessionId}/files`);
      const data = await res.json();
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setNotice(data.reason || data.error || null);
      setIsDirect(Boolean(data.isDirect));
    } catch {
      setNotice('Could not load the file list — try again in a moment.');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep the tree live while it's actually being looked at -- only while
  // showing the list itself, not while a single file's content is open in
  // the editor (openFile !== null), so an in-progress edit never gets
  // clobbered by a background refetch.
  useEffect(() => {
    if (openFile) return;
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [refresh, openFile]);

  const openFileContent = useCallback(
    async (path: string) => {
      setOpenFile({ path, loading: true });
      try {
        const res = await fetch(`/api/chats/${sessionId}/files?content=${encodeURIComponent(path)}`);
        const data = await res.json();
        if (data.error) setOpenFile({ path, loading: false, error: data.error });
        else setOpenFile({ path, loading: false, content: data.content, truncatedNotice: data.truncatedNotice });
      } catch {
        setOpenFile({ path, loading: false, error: 'Could not load this file.' });
      }
    },
    [sessionId]
  );

  const saveFile = useCallback(
    async (path: string, content: string) => {
      const res = await fetch(`/api/chats/${sessionId}/files`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Could not save this file.');
      setOpenFile(prev => (prev && prev.path === path ? { ...prev, content } : prev));
    },
    [sessionId]
  );

  // Download the whole project as a .tar.gz (2026-07-17) -- hits the
  // ?zip=1 endpoint (files/route.ts) and triggers a real browser download
  // via a throwaway <a>, same trick as downloadFile below. Kept as an
  // actual fetch + blob (not a plain `<a href>` navigation) so a server
  // error comes back as a real JSON error this component can show,
  // instead of the browser just silently landing on a JSON error page.
  const downloadProject = useCallback(async () => {
    setZipping(true);
    try {
      const res = await fetch(`/api/chats/${sessionId}/files?zip=1`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setNotice(data?.error || 'Could not create the project archive.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `project-${sessionId.slice(0, 8)}.tar.gz`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setNotice('Could not create the project archive — try again in a moment.');
    } finally {
      setZipping(false);
    }
  }, [sessionId]);

  // Download a single open file (2026-07-17) -- reuses the content
  // already loaded into the editor rather than re-fetching, so it works
  // instantly and identically on both the direct/BYOK and read-only eve
  // paths (the latter has no live sandbox to hit a fresh download
  // endpoint against, but it already has the file's text right here).
  const downloadFile = useCallback((path: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || path;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  if (openFile) {
    return (
      <div className="flex flex-col h-full">
        <div className="h-9 border-b border-border px-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <FileIcon name={openFile.path.split('/').pop() || openFile.path} />
            <span className="text-xs font-mono truncate">{openFile.path}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {openFile.content !== undefined && (
              <button
                onClick={() => downloadFile(openFile.path, openFile.content!)}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent"
                title="Download this file"
              >
                Download
              </button>
            )}
            <button onClick={() => setOpenFile(null)} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent">
              Back
            </button>
          </div>
        </div>
        {openFile.truncatedNotice && (
          <div className="px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400 bg-amber-500/10 border-b border-amber-500/20 shrink-0">
            {openFile.truncatedNotice}
          </div>
        )}
        <div className="flex-1 min-h-0 relative">
          {openFile.loading && <div className="text-xs text-muted-foreground p-3">Loading…</div>}
          {openFile.error && <div className="text-xs text-muted-foreground p-3">{openFile.error}</div>}
          {openFile.content !== undefined && (
            <CodeEditor
              path={openFile.path}
              content={openFile.content}
              readOnly={!isDirect || Boolean(openFile.truncatedNotice)}
              onSave={content => saveFile(openFile.path, content)}
            />
          )}
        </div>
      </div>
    );
  }

  // Substring match against the full path, case-insensitive -- a plain
  // filter of the flat entries list before rebuilding the tree, so every
  // ancestor directory of a match is still reconstructed correctly by
  // buildTree() (it derives dir nodes from each surviving file's path
  // components), while non-matching branches just naturally disappear.
  const trimmedSearch = search.trim().toLowerCase();
  const filteredEntries = trimmedSearch ? (entries ?? []).filter(e => e.path.toLowerCase().includes(trimmedSearch)) : entries;
  const tree = filteredEntries ? buildTree(filteredEntries) : null;
  const noMatches = Boolean(trimmedSearch) && filteredEntries?.length === 0 && (entries?.length ?? 0) > 0;

  return (
    <div className="flex flex-col h-full">
      <div className="h-9 border-b border-border px-3 flex items-center justify-between shrink-0 gap-2">
        <span className="text-xs text-muted-foreground shrink-0">
          {entries ? (trimmedSearch ? `${filteredEntries?.length ?? 0}/${entries.length}` : `${entries.length} items`) : 'Files'}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {isDirect && entries && entries.length > 0 && (
            <button
              onClick={downloadProject}
              disabled={zipping}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent disabled:opacity-50"
              title="Download the whole project as a .tar.gz"
            >
              {zipping ? 'Zipping…' : 'Download all'}
            </button>
          )}
          <button onClick={refresh} disabled={loading} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent disabled:opacity-50">
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      {entries && entries.length > 0 && (
        <div className="px-2 pt-1.5 pb-1 shrink-0">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter files…"
            className="w-full text-xs px-2 py-1 rounded-md border border-border bg-background placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
        </div>
      )}
      <div className="flex-1 overflow-auto py-1.5 px-1">
        {!entries && !notice && <div className="text-xs text-muted-foreground px-3 py-2">Loading…</div>}
        {entries && entries.length === 0 && !notice && (
          <div className="text-xs text-muted-foreground px-3 py-2">No files yet.</div>
        )}
        {notice && <div className="text-xs text-muted-foreground px-3 py-2">{notice}</div>}
        {noMatches && <div className="text-xs text-muted-foreground px-3 py-2">No files match "{search.trim()}".</div>}
        {tree && sortedChildren(tree).map(child => <TreeRow key={child.path} node={child} depth={0} onOpenFile={openFileContent} />)}
      </div>
    </div>
  );
}
