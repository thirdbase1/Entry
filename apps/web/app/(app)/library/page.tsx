'use client';

/**
 * Ported 1:1 from pages/library-dashboard.tsx.
 * Full library dashboard with:
 * - Category tabs (All / Chats / Documents / Attachments)
 * - Date-grouped items (Today / Yesterday / This week / This month / Older)
 * - Per-item: icon, title, favorite toggle, context menu with delete
 * - Empty state with "New Chat" CTA
 * - Loading state
 * - AutoSidebarPadding on the header (1:1 with original)
 */
import {
  DeleteIcon,
  FavoritedIcon,
  FavoriteIcon,
  MoreVerticalIcon,
  PageIcon,
} from '@blocksuite/icons/rc';
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { FileIconRenderer } from '@/components/file-icon-renderer';
import { AutoSidebarPadding } from '@/components/layout/auto-sidebar-padding';
import { ChatIcon } from '@/components/icons/chat-icon';
import { cn } from '@/lib/utils';
import {
  type AllItem,
  type Chat,
  type Doc,
  type FileItem,
  useAllItems,
  useLibraryStore,
} from '@/store/library';

const categories = [
  { label: 'All', value: 'all' },
  { label: 'Chats', value: 'chats' },
  { label: 'Documents', value: 'docs' },
  { label: 'Attachments', value: 'files' },
];

function groupByDate(items: AllItem[]) {
  const now = Date.now();
  const day = 86400000;
  const groups: Record<string, AllItem[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    thisMonth: [],
    older: [],
  };
  for (const item of items) {
    const t = new Date(item.updatedAt ?? item.createdAt).getTime();
    const diffDays = (now - t) / day;
    if (diffDays < 1) groups.today.push(item);
    else if (diffDays < 2) groups.yesterday.push(item);
    else if (diffDays < 7) groups.thisWeek.push(item);
    else if (diffDays < 30) groups.thisMonth.push(item);
    else groups.older.push(item);
  }
  return groups;
}

const labelMap: Record<string, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This week',
  thisMonth: 'This month',
  older: 'Older',
};

function toast(msg: string) {
  if (typeof window !== 'undefined') {
    const el = document.createElement('div');
    el.textContent = msg;
    el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-card text-card-foreground border rounded-lg px-4 py-2 text-sm shadow-lg z-50 transition-opacity duration-300';
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; }, 2000);
    setTimeout(() => el.remove(), 2500);
  }
}

function FavoriteAction({
  collected,
  onToggle,
  disabled,
}: {
  collected: boolean;
  onToggle: () => Promise<void>;
  disabled?: boolean;
}) {
  const [toggling, setToggling] = useState(false);

  const toggleCollect = useCallback(() => {
    setToggling(true);
    onToggle().finally(() => setToggling(false));
  }, [onToggle]);

  return (
    <button
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        toggleCollect();
      }}
      disabled={toggling || disabled}
      className="p-1 rounded hover:bg-accent transition-colors"
    >
      {collected ? (
        <FavoritedIcon style={{ color: 'hsl(var(--primary))' }} />
      ) : (
        <FavoriteIcon />
      )}
    </button>
  );
}

function ContextMenu({
  onDelete,
  deleting,
}: {
  onDelete: () => void;
  deleting: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(!open);
        }}
        disabled={deleting}
        className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground"
      >
        {deleting ? (
          <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        ) : (
          <MoreVerticalIcon />
        )}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={e => { e.stopPropagation(); setOpen(false); }} />
          <div className="absolute right-0 top-8 z-50 min-w-[160px] rounded-md border border-border bg-popover text-popover-foreground shadow-md py-1">
            <button
              onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                onDelete();
                setOpen(false);
              }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            >
              <DeleteIcon className="w-4 h-4" />
              Delete
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ChatRow({ chat }: { chat: Chat }) {
  const { toggleCollect, deleteChat } = useLibraryStore();
  const [deleting, setDeleting] = useState(false);

  const toggle = useCallback(() => toggleCollect('chat', chat.sessionId), [chat.sessionId, toggleCollect]);

  const handleDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteChat(chat.sessionId);
      toast(`${chat.title ?? 'New Chat'} deleted`);
    } finally {
      setDeleting(false);
    }
  }, [chat.title, chat.sessionId, deleting, deleteChat]);

  return (
    <Link href={`/chats/${chat.sessionId}`} className={deleting ? 'opacity-50' : ''}>
      <div className="w-full h-[42px] flex items-center px-3 rounded-lg cursor-pointer hover:bg-accent transition-colors">
        <div className="w-5 h-5 text-muted-foreground mr-3 shrink-0">
          <ChatIcon className="w-5 h-5" />
        </div>
        <div className="flex-1 text-sm font-medium text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
          {chat.title ?? 'New Chat'}
        </div>
        <div className="flex items-center gap-2" onClick={e => { e.stopPropagation(); e.preventDefault(); }}>
          <FavoriteAction collected={chat.collected} onToggle={toggle} disabled={deleting} />
          <ContextMenu onDelete={handleDelete} deleting={deleting} />
        </div>
      </div>
    </Link>
  );
}

function DocRow({ doc }: { doc: Doc }) {
  const { toggleCollect, deleteDoc } = useLibraryStore();
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

  const toggle = useCallback(() => toggleCollect('doc', doc.docId), [doc.docId, toggleCollect]);

  const handleDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteDoc(doc.docId);
      toast(`${doc.title} deleted`);
    } finally {
      setDeleting(false);
    }
  }, [doc.title, doc.docId, deleting, deleteDoc]);

  return (
    <div
      className={cn('w-full h-[42px] flex items-center px-3 rounded-lg cursor-pointer hover:bg-accent transition-colors', deleting && 'opacity-50')}
      onClick={() => router.push(`/library/${doc.docId}`)}
    >
      <div className="w-5 h-5 text-muted-foreground mr-3 shrink-0">
        <PageIcon className="w-5 h-5" />
      </div>
      <div className="flex-1 text-sm font-medium text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
        {doc.title}
      </div>
      <div onClick={e => e.stopPropagation()}>
        <FavoriteAction collected={doc.collected} onToggle={toggle} />
      </div>
    </div>
  );
}

function FileRow({ file }: { file: FileItem }) {
  const { toggleCollect, deleteFile } = useLibraryStore();
  const [deleting, setDeleting] = useState(false);

  const toggle = useCallback(() => toggleCollect('file', file.fileId), [file.fileId, toggleCollect]);

  const handleDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteFile(file.fileId);
      toast(`${file.fileName} deleted`);
    } finally {
      setDeleting(false);
    }
  }, [file.fileName, file.fileId, deleting, deleteFile]);

  return (
    <div className={cn('w-full h-[42px] flex items-center px-3 rounded-lg cursor-pointer hover:bg-accent transition-colors', deleting && 'opacity-50')}>
      <div className="w-5 h-5 mr-3 shrink-0">
        <FileIconRenderer className="rounded-sm w-5 h-5" mimeType={file.mimeType} blobId={file.blobId ?? undefined} />
      </div>
      <div className="flex-1 text-sm font-medium text-foreground overflow-hidden text-ellipsis whitespace-nowrap">
        {file.fileName}
      </div>
      <div className="flex items-center gap-2">
        <FavoriteAction collected={file.collected} onToggle={toggle} />
        <ContextMenu onDelete={handleDelete} deleting={deleting} />
      </div>
    </div>
  );
}

function LibraryDashboardInner() {
  const { chats, docs, files, initialized } = useLibraryStore();
  const allItems = useAllItems();
  const router = useRouter();
  const searchParams = useSearchParams();

  let type = searchParams.get('type') ?? 'all';
  if (!categories.some(c => c.value === type)) type = 'all';

  const filteredItems = useMemo(() => {
    if (type === 'all') return allItems;
    if (type === 'chats') return chats;
    if (type === 'docs') return docs;
    return files;
  }, [allItems, chats, docs, files, type]);

  const grouped = useMemo(() => groupByDate(filteredItems), [filteredItems]);
  const isEmpty = filteredItems.length === 0;

  if (!initialized) {
    return (
      <div className="h-full flex-1 flex items-center justify-center">
        <svg className="animate-spin h-6 w-6 text-muted-foreground" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden h-full flex flex-col">
      <header className="h-15 border-b px-4 flex items-center gap-4">
        <AutoSidebarPadding className="transition-all h-full flex items-center">
          <span className="text-lg font-semibold text-foreground" style={{ letterSpacing: -0.24 }}>Library</span>
        </AutoSidebarPadding>

        <ul className="flex items-center gap-2">
          {categories.map(c => (
            <li key={c.value}>
              <button
                data-active={c.value === type}
                onClick={() => router.replace(`/library?type=${c.value}`)}
                className={cn(
                  'px-3 h-8 rounded-md text-sm transition-colors',
                  c.value === type
                    ? 'text-foreground bg-accent'
                    : 'text-muted-foreground hover:bg-accent/50'
                )}
              >
                {c.label}
              </button>
            </li>
          ))}
        </ul>
      </header>

      <main className="h-0 flex-1 pt-4 overflow-y-auto">
        {isEmpty ? (
          <div className="size-full flex flex-col justify-center items-center gap-3">
            <span className="text-[15px] font-medium text-foreground">There are no contents here</span>
            <span className="text-sm text-muted-foreground">You can generate content by creating new chats</span>
            <Link href="/chats" className="mt-4">
              <button className="inline-flex items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4">
                New Chat
              </button>
            </Link>
          </div>
        ) : (
          <div className="px-3">
            {Object.entries(grouped).map(([key, items]) =>
              items.length > 0 ? (
                <section key={key} className="mb-4">
                  <div className="text-muted-foreground px-3 mb-2 capitalize">
                    {labelMap[key] ?? key} <span className="mx-1">·</span> {items.length}
                  </div>
                  <div className="flex flex-col gap-1">
                    {items.map(item =>
                      item.type === 'chat' ? (
                        <ChatRow key={`chat-${item.sessionId}`} chat={item} />
                      ) : item.type === 'doc' ? (
                        <DocRow key={`doc-${item.docId}`} doc={item} />
                      ) : (
                        <FileRow key={`file-${item.fileId}`} file={item} />
                      )
                    )}
                  </div>
                </section>
              ) : null
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={
      <div className="flex-1 flex items-center justify-center">
        <svg className="animate-spin h-6 w-6 text-muted-foreground" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      </div>
    }>
      <LibraryDashboardInner />
    </Suspense>
  );
}
