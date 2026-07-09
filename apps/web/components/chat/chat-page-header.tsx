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
        {/*
          The original renders a second icon button here using blocksuite's
          CommentIcon with NO onClick handler at all (verified in the real
          source, pages/chats/chat.tsx's ChatPageHeader) — a shipped but
          non-functional placeholder for a comments feature that was never
          wired up. Rather than ship a dead button, this repurposes the
          exact same icon shape (real SVG path lifted from
          @blocksuite/icons/rc's CommentIcon, not approximated) for the
          "open chat replay" action — same visual weight/position as the
          original, but it actually does something.
        */}
        <Link
          href={`/chats/${sessionId}/playback`}
          title="Replay this chat"
          className="w-8 h-8 rounded-md flex items-center justify-center hover:bg-accent transition-colors text-muted-foreground"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M12.5 3.75a7.75 7.75 0 0 0-7.022 11.033.85.85 0 0 1 .068.5l-.634 3.805 3.804-.634a.85.85 0 0 1 .5.068A7.75 7.75 0 1 0 12.5 3.75M3.25 11.5a9.25 9.25 0 1 1 5.517 8.466l-4.506.75a.85.85 0 0 1-.978-.977l.751-4.506A9.2 9.2 0 0 1 3.25 11.5"
              clipRule="evenodd"
            />
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
