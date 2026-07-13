'use client';

/**
 * "Files" tab content for ChatPreviewPanel (2026-07-13, explicit user
 * request: a visible file tree for what the agent's sandbox is working
 * on, not just the running preview). See /api/chats/[sessionId]/files
 * for the two-path split rationale (direct/BYOK: live sandbox read;
 * eve-default path: whatever `list_files` last wrote).
 *
 * Deliberately simple: flat entry list -> nested tree built client-side,
 * click a file to fetch+show its content inline (direct/BYOK only — the
 * API 400s with an explanatory message on the eve path, which we render
 * as-is rather than special-casing).
 */
import { useCallback, useEffect, useState } from 'react';

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
  const [openFile, setOpenFile] = useState<{ path: string; content?: string; error?: string; loading: boolean } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/chats/${sessionId}/files`);
      const data = await res.json();
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setNotice(data.reason || data.error || null);
    } catch {
      setNotice('Could not load the file list — try again in a moment.');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  if (openFile) {
    return (
      <div className="flex flex-col h-full">
        <div className="h-9 border-b border-border px-3 flex items-center justify-between shrink-0">
          <span className="text-xs font-mono truncate">{openFile.path}</span>
          <button onClick={() => setOpenFile(null)} className="text-xs text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-accent">
            Back
          </button>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {openFile.loading && <div className="text-xs text-muted-foreground">Loading…</div>}
          {openFile.error && <div className="text-xs text-muted-foreground">{openFile.error}</div>}
          {openFile.content !== undefined && (
            <pre className="text-xs font-mono whitespace-pre-wrap break-words">{openFile.content}</pre>
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
