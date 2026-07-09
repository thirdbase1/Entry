'use client';

/**
 * Ported from components/cmdk/cmdk.tsx + cmdk.css.ts — the ⌘K command
 * palette: search across chats/docs/files, plus quick actions
 * (start a new chat with typed text, "New Chat", "Open Library").
 *
 * Adaptations from the original:
 * - `react-router-dom`'s `useNavigate` -> `next/navigation`'s `useRouter`.
 * - The original's `Modal`/`IconButton`/`RowInput` (from `@afk/component`,
 *   not ported — internal design-system package specific to the original
 *   repo, not published) replaced with a plain fixed-overlay div + native
 *   input, same visual contract (centered card, ⌘K-styled trigger button).
 * - `FileIconRenderer` (renders a thumbnail per mime-type) not ported yet
 *   (needs the copilot files blob-preview endpoint); a generic file icon
 *   stands in for now.
 * - date-fns replaces dayjs for the Today/Yesterday/This Week grouping
 *   (dayjs isn't installed in this app; date-fns already is via other
 *   deps) — same grouping semantics.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLibraryStore, type AllItem } from '@/store/library';
import { ChatIcon } from '@/components/icons/chat-icon';
import { cn } from '@/lib/utils';

interface PaletteItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  action: () => void;
  timestamp: number;
  group: 'action' | 'item';
}

function startOf(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayBucket(timestamp: number): 'Today' | 'Yesterday' | 'This Week' | 'This Month' | 'Older' {
  const now = startOf(new Date());
  const day = startOf(new Date(timestamp));
  const diffDays = Math.round((now.getTime() - day.getTime()) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 7) return 'This Week';
  if (diffDays <= 30) return 'This Month';
  return 'Older';
}

function itemLabel(item: AllItem): string {
  if (item.type === 'chat') return item.title ?? 'Untitled chat';
  if (item.type === 'doc') return item.title;
  return item.fileName;
}

function itemIcon(item: AllItem): React.ReactNode {
  if (item.type === 'chat') return <ChatIcon className="w-4 h-4" />;
  if (item.type === 'doc') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M13 2v7h7" />
    </svg>
  );
}

export function Cmdk({ className }: { className?: string }) {
  const router = useRouter();
  const { chats, docs, files } = useLibraryStore();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setSearch('');
    }
  }, [open]);

  const libraryItems: PaletteItem[] = useMemo(() => {
    const lower = search.toLowerCase();
    const all: AllItem[] = [...chats, ...docs, ...files];
    return all
      .filter(item => (lower ? itemLabel(item).toLowerCase().includes(lower) : true))
      .map(item => {
        const id = item.type === 'chat' ? item.sessionId : item.type === 'doc' ? item.docId : item.fileId;
        const path = item.type === 'chat' ? `/chats/${id}` : `/library/${id}`;
        return {
          key: id,
          label: itemLabel(item),
          icon: itemIcon(item),
          action: () => {
            router.push(path);
            setOpen(false);
          },
          timestamp: new Date(item.updatedAt ?? item.createdAt).getTime(),
          group: 'item' as const,
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [chats, docs, files, search, router]);

  const actionItems: PaletteItem[] = useMemo(() => {
    const actions: PaletteItem[] = [];
    if (search.length > 0) {
      actions.push({
        key: 'action-new-chat-with-text',
        label: `Start a new chat with: "${search}"`,
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        ),
        action: () => {
          router.push(`/chats?msg=${encodeURIComponent(search)}`);
          setOpen(false);
        },
        timestamp: Number.MAX_SAFE_INTEGER,
        group: 'action',
      });
    }
    actions.push({
      key: 'action-new-chat',
      label: 'New Chat',
      icon: <ChatIcon className="w-4 h-4" />,
      action: () => {
        router.push('/chats');
        setOpen(false);
      },
      timestamp: Number.MAX_SAFE_INTEGER,
      group: 'action',
    });
    actions.push({
      key: 'action-open-library',
      label: 'Open Library',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
        </svg>
      ),
      action: () => {
        router.push('/library');
        setOpen(false);
      },
      timestamp: Number.MAX_SAFE_INTEGER,
      group: 'action',
    });
    const lower = search.toLowerCase();
    return lower ? actions.filter(a => a.label.toLowerCase().includes(lower) || a.key === 'action-new-chat-with-text') : actions;
  }, [search, router]);

  const finalItems = [...actionItems, ...libraryItems];

  useEffect(() => setActiveIndex(0), [search]);

  const groups = useMemo(() => {
    const res: Record<string, PaletteItem[]> = { Today: [], Yesterday: [], 'This Week': [], 'This Month': [], Older: [] };
    for (const item of libraryItems) res[dayBucket(item.timestamp)].push(item);
    return res;
  }, [libraryItems]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          'h-[34px] rounded-lg border bg-card flex items-center px-2 gap-2 text-left w-full',
          className
        )}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground shrink-0">
          <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
        </svg>
        <span className="text-sm text-muted-foreground truncate flex-1">Search</span>
        <span className="text-xs text-muted-foreground border rounded px-1">⌘K</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[min(200px,20vh)] px-6" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-background/60" />
          <div
            onClick={e => e.stopPropagation()}
            className="relative w-full max-w-[720px] max-h-[420px] min-h-[80px] rounded-xl border bg-popover text-popover-foreground shadow-lg flex flex-col overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b px-4">
              <input
                ref={inputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search chats, docs, files…"
                className="h-14 flex-1 bg-transparent outline-none text-base text-foreground placeholder:text-muted-foreground"
                onKeyDown={e => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActiveIndex(i => Math.min(i + 1, finalItems.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActiveIndex(i => Math.max(i - 1, 0));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    finalItems[activeIndex]?.action();
                  }
                }}
              />
              <button onClick={() => setOpen(false)} className="w-6 h-6 flex items-center justify-center rounded hover:bg-accent text-muted-foreground">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="overflow-y-auto flex-1 py-2">
              {actionItems.length > 0 && (
                <div className="flex flex-col gap-0.5 px-2 mb-3">
                  <div className="text-xs text-muted-foreground px-2 py-1">Actions</div>
                  {actionItems.map(item => {
                    const idx = finalItems.findIndex(i => i.key === item.key);
                    return (
                      <div
                        key={item.key}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={item.action}
                        className={cn('flex items-center gap-2 px-2 h-8 rounded-md cursor-pointer text-sm text-foreground', idx === activeIndex && 'bg-accent')}
                      >
                        <span className="w-4 h-4 flex items-center justify-center shrink-0">{item.icon}</span>
                        <span className="truncate">{item.label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {(Object.keys(groups) as (keyof typeof groups)[]).map(groupName =>
                groups[groupName].length === 0 ? null : (
                  <div key={groupName} className="flex flex-col gap-0.5 px-2 mb-3">
                    <div className="text-xs text-muted-foreground px-2 py-1">{groupName}</div>
                    {groups[groupName].map(item => {
                      const idx = finalItems.findIndex(i => i.key === item.key);
                      return (
                        <div
                          key={item.key}
                          onMouseEnter={() => setActiveIndex(idx)}
                          onClick={item.action}
                          className={cn('flex items-center gap-2 px-2 h-8 rounded-md cursor-pointer text-sm text-foreground', idx === activeIndex && 'bg-accent')}
                        >
                          <span className="w-4 h-4 flex items-center justify-center shrink-0 text-muted-foreground">{item.icon}</span>
                          <span className="truncate">{item.label}</span>
                        </div>
                      );
                    })}
                  </div>
                )
              )}
              {finalItems.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">No results</div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
