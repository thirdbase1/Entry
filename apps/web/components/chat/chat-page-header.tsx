'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useLibraryStore, useAllItems, type Chat } from '@/store/library';
import { cn } from '@/lib/utils';

export function ChatPageHeader({ sessionId }: { sessionId: string }) {
  const { toggleCollect } = useLibraryStore();
  const items = useAllItems();
  const chat = items.find((i): i is Chat => i.type === 'chat' && i.sessionId === sessionId);
  const isFav = chat?.collected;

  const toggle = useCallback(async () => {
    await toggleCollect('chat', sessionId);
  }, [sessionId, toggleCollect]);

  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);

  // Real public share link, backed by EveChatSession.isPublic/shareToken —
  // generates (once) and enables the share token, then copies the
  // anonymous-accessible /share/[token] URL. See app/share/[token] and
  // schema.prisma's EveChatSession comment for the fuller decision writeup.
  const share = useCallback(async () => {
    setSharing(true);
    try {
      const res = await fetch(`/api/chats/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setPublic: true }),
      });
      if (!res.ok) return;
      const { shareToken } = await res.json();
      if (!shareToken) return;
      const link = `${window.location.origin}/share/${shareToken}`;
      await navigator.clipboard.writeText(link).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } finally {
      setSharing(false);
    }
  }, [sessionId]);

  return (
    <div className="h-15 border-b border-border px-4 flex items-center justify-between">
      <div className="text-sm font-medium text-foreground truncate">{chat?.title ?? 'New Chat'}</div>
      <div className="flex items-center gap-2">
        <button
          onClick={toggle}
          className={cn(
            'w-8 h-8 rounded-md flex items-center justify-center hover:bg-accent transition-colors',
            isFav && 'text-primary'
          )}
          title={isFav ? 'Remove from favorites' : 'Add to favorites'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </button>
        <Link
          href={`/chats/${sessionId}/playback`}
          title="Replay this chat"
          className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-accent transition-colors text-muted-foreground"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </Link>
        <button
          onClick={share}
          disabled={sharing}
          title="Create a public, view-only link anyone can open without signing in"
          className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-input bg-card hover:bg-accent transition-colors h-8 px-3 disabled:opacity-60"
        >
          {copied ? 'Link copied' : sharing ? 'Sharing…' : 'Share'}
        </button>
      </div>
    </div>
  );
}
