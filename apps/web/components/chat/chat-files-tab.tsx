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
 * FIXED (2026-07-15, real confirmed bug -- "the file tree is not
 * properly connected to show the sandbox files"): this only ever fetched
 * once, on mount. The sandbox itself was always the right one (same
 * `direct-chat-${chatId}` handle the bash/browser_use tools use --
 * verified in lib/direct-chat/sandbox.ts), the tab was just showing a
 * frozen snapshot from whenever it happened to first open -- any file the
 * agent created or edited afterward while this tab stayed open was
 * invisible until the user remembered to click Refresh by hand. Now
 * polls on the same cadence as the preview status (while the tree view is
 * showing, not the file-content editor -- no point refetching the whole
 * tree while someone's actively reading/editing one open file), so it
 * actually tracks the live sandbox instead of a snapshot of it.
 */
import { useCallback, useEffect, useState } from 'react';
import { CodeEditor } from './code-editor';

type Entry = { path: string; type: 'file' | 'dir'; size?: number };
type TreeNode = { name: string; path: string; type: 'file' | 'dir'; children: Map<string, TreeNode> };

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
          children: new Map(),
        });
      }
      cursor = cursor.children.get(part)!;
    });
  }
  return root;
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
  const children = Array.from(node.children.values());

  if (node.type === 'file') {
    return (
      <button
        onClick={() => onOpenFile(node.path)}
        className="w-full text-left text-xs px-2 py-1 rounded hover:bg-accent flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        title={node.path}
      >
        <span className="opacity-60">📄</span>
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full text-left text-xs px-2 py-1 rounded hover:bg-accent flex items-center gap-1.5 font-medium"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <span className="opacity-70">{open ? '📂' : '📁'}</span>
        <span className="truncate">{node.name || '/'}</span>
      </button>
      {open && children.map(child => <TreeRow key={child.path} node={child} depth={depth + 1} onOpenFile={onOpenFile} />)}
    </div>
  );
}

export function ChatFilesTab({ sessionId }: { sessionId: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isDirect, setIsDirect] = useState(false);
  const [openFile, setOpenFile] = useState<{ path: string; content?: string; error?: string; loading: boolean } | null>(null);

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
        else setOpenFile({ path, loading: false, content: data.content });
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

  if (openFile) {
    return (
      <div className="flex flex-col h-full">
        <div className="h-9 border-b border-border px-3 flex items-center justify-between shrink-0">
          <span className="text-xs font-mono truncate">{openFile.path}</span>
          <button onClick={() => setOpenFile(null)} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent">
            Back
          </button>
        </div>
        <div className="flex-1 min-h-0 relative">
          {openFile.loading && <div className="text-xs text-muted-foreground p-3">Loading…</div>}
          {openFile.error && <div className="text-xs text-muted-foreground p-3">{openFile.error}</div>}
          {openFile.content !== undefined && (
            <CodeEditor
              path={openFile.path}
              content={openFile.content}
              readOnly={!isDirect}
              onSave={content => saveFile(openFile.path, content)}
            />
          )}
        </div>
      </div>
    );
  }

  const tree = entries ? buildTree(entries) : null;

  return (
    <div className="flex flex-col h-full">
      <div className="h-9 border-b border-border px-3 flex items-center justify-between shrink-0">
        <span className="text-xs text-muted-foreground">{entries ? `${entries.length} items` : 'Files'}</span>
        <button onClick={refresh} disabled={loading} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent disabled:opacity-50">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {!entries && !notice && <div className="text-xs text-muted-foreground px-3 py-2">Loading…</div>}
        {entries && entries.length === 0 && !notice && (
          <div className="text-xs text-muted-foreground px-3 py-2">No files yet.</div>
        )}
        {notice && <div className="text-xs text-muted-foreground px-3 py-2">{notice}</div>}
        {tree && Array.from(tree.children.values()).map(child => <TreeRow key={child.path} node={child} depth={0} onOpenFile={openFileContent} />)}
      </div>
    </div>
  );
}
