'use client';

import { EditIcon, AllDocsIcon, FileIcon, SettingsIcon } from '@blocksuite/icons/rc';
import { ChatIcon } from '@/components/icons/chat-icon';
import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo } from 'react';
import AppSidebar from '@/components/ui/sidebar/sidebar';
import { ThemeToggle } from '@/components/theme-toggle';
import { UserInfo } from '@/components/sidebar/user-info';
import { Cmdk } from '@/components/cmdk';
import { cn } from '@/lib/utils';
import {
  type Chat,
  type FileItem,
  useAllItems,
  useLibraryStore,
} from '@/store/library';
import { useSidebarStore } from '@/store/sidebar';

const filterCollected = (items: AllItem[]) =>
  items.filter(item => item?.collected);
type AllItem = Chat | FileItem;

function ChatItem({ chat }: { chat: Chat }) {
  const pathname = usePathname();
  const isActive = pathname === `/chats/${chat.sessionId}`;
  return (
    <Link href={`/chats/${chat.sessionId}`}>
      <li className={cn(
        'h-[30px] rounded flex items-center gap-3 px-2 cursor-pointer hover:bg-accent transition-colors',
        isActive && 'bg-accent'
      )}>
        <ChatIcon className="w-5 h-5 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm">{chat.title ?? 'New Chat'}</div>
      </li>
    </Link>
  );
}

function FileItemRow({ file }: { file: FileItem }) {
  const pathname = usePathname();
  const isActive = pathname === `/library/${file.fileId}`;
  return (
    <Link href={`/library/${file.fileId}`}>
      <li className={cn(
        'h-[30px] rounded flex items-center gap-3 px-2 cursor-pointer hover:bg-accent transition-colors',
        isActive && 'bg-accent'
      )}>
        <FileIcon className="w-5 h-5 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm">{file.fileName}</div>
      </li>
    </Link>
  );
}

function SidebarContent() {
  const { refresh, chats, initialized, loading } = useLibraryStore();
  const allItems = useAllItems();
  const collectedItems = useMemo(() => filterCollected(allItems), [allItems]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const pathname = usePathname();
  const inChats = pathname === '/chats';
  const inLibrary = pathname.startsWith('/library');
  const inSettings = pathname.startsWith('/settings');

  return (
    <div className="size-full flex flex-col">
      <div className="flex flex-col gap-1 px-2">
        <UserInfo />
        <Cmdk className="mb-1" />
        <Link href="/chats">
          <li className={cn(
            'flex items-center gap-3 h-[30px] px-2 rounded hover:bg-accent transition-colors cursor-pointer',
            inChats && 'bg-accent'
          )}>
            <EditIcon className="w-5 h-5 text-muted-foreground" />
            <div className="text-sm">New Chat</div>
          </li>
        </Link>
        <Link href="/library">
          <li className={cn(
            'flex items-center gap-3 h-[30px] px-2 rounded hover:bg-accent transition-colors cursor-pointer',
            inLibrary && 'bg-accent'
          )}>
            <AllDocsIcon className="w-5 h-5 text-muted-foreground" />
            <div className="text-sm">Library</div>
          </li>
        </Link>
        <Link href="/settings">
          <li className={cn(
            'flex items-center gap-3 h-[30px] px-2 rounded hover:bg-accent transition-colors cursor-pointer',
            inSettings && 'bg-accent'
          )}>
            <SettingsIcon className="w-5 h-5 text-muted-foreground" />
            <div className="text-sm">Settings</div>
          </li>
        </Link>
      </div>

      <div className="px-2 flex-1 h-0 overflow-y-auto">
        {/* Recent */}
        <section className="my-2">
          {initialized ? null : loading ? (
            <div className="px-2 text-muted-foreground text-sm flex items-center gap-3">
              Loading history...
            </div>
          ) : null}
          {chats.length > 0 ? (
            <h3 className="text-xs h-5 flex items-center gap-2 px-2 mb-1 mt-4 text-muted-foreground font-medium">
              Recent
            </h3>
          ) : null}
          <AnimatePresence>
            <ul className="flex flex-col gap-1">
              {chats.slice(0, 5).map(chat => (
                <motion.div
                  key={chat.sessionId}
                  layout
                  initial={{ opacity: 0, scaleY: 0.8 }}
                  animate={{ opacity: 1, scaleY: 1 }}
                  exit={{ opacity: 0, scaleY: 0.5 }}
                  transition={{ duration: 0.3 }}
                >
                  <ChatItem chat={chat} />
                </motion.div>
              ))}
            </ul>
          </AnimatePresence>
        </section>

        {collectedItems.length > 0 ? (
          <h3 className="text-xs h-5 flex items-center gap-2 px-2 mb-2 pt-2 mt-2 text-muted-foreground font-medium">
            Favorites
          </h3>
        ) : null}
        <AnimatePresence>
          <ul className="flex flex-col gap-1">
            {collectedItems.map(item => (
              <motion.div
                key={item.type === 'chat' ? item.sessionId : item.fileId}
                layout
                initial={{ opacity: 0, scaleY: 0.8 }}
                animate={{ opacity: 1, scaleY: 1 }}
                exit={{ opacity: 0, scaleY: 0.5 }}
                transition={{ duration: 0.3 }}
              >
                {item.type === 'chat' ? (
                  <ChatItem chat={item} />
                ) : (
                  <FileItemRow file={item} />
                )}
              </motion.div>
            ))}
          </ul>
        </AnimatePresence>
      </div>
    </div>
  );
}

export function MainLayout({ children }: { children: React.ReactNode }) {
  const { open: sidebarOpen, toggleSidebar, setOpen: setSidebarOpen, width } = useSidebarStore();

  // Tap-anywhere-to-close (2026-07-15, explicit user request: "if the
  // side bar is open if I touch any where on the chat screen it should
  // close the side bar"). Only closes -- never opens -- and only fires
  // while the sidebar is actually open, so it doesn't interfere with
  // normal interaction with the chat once the sidebar is already closed.
  // Deliberately a plain bubbling onClick (no stopPropagation/preventDefault
  // anywhere), so whatever the user actually tapped -- a button, a link,
  // the composer -- still gets its own click too; this just additionally
  // closes the sidebar in the same gesture.
  const closeSidebarIfOpen = useCallback(() => {
    if (sidebarOpen) setSidebarOpen(false);
  }, [sidebarOpen, setSidebarOpen]);

  return (
    <div className="relative flex size-full justify-end h-dvh">
      {/* sidebar */}
      <AppSidebar id="app-sidebar" className="bg-muted/30">
        <header className="w-full h-15 p-3 flex items-center justify-between">
          <img src="/logo.jpg" alt="logo" className="w-6 h-6" />
          <ThemeToggle />
        </header>
        <div className="flex-1 h-0">
          <SidebarContent />
        </div>
      </AppSidebar>

      {/* main content area */}
      <main className="w-0 flex-1 h-full flex gap-2" onClick={closeSidebarIfOpen}>
        {children}
      </main>

      {/* sidebar toggle button */}
      <button
        onClick={toggleSidebar}
        className="absolute p-2 rounded hover:bg-accent transition-colors"
        style={{
          left: sidebarOpen ? width - 20 : 12,
          top: 16,
          transition: 'all 0.2s ease',
        }}
        title="Toggle sidebar"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M9 3v18" />
        </svg>
      </button>
    </div>
  );
}
