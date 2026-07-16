'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLibraryStore, useAllItems, type Chat } from '@/store/library';
import { cn } from '@/lib/utils';
import { ChatPreviewPanel } from './chat-preview-panel';
import { usePreviewAutoFix } from './use-preview-autofix';
import { useChatPanel } from './chat-panel-context';

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
  const [previewOpen, setPreviewOpen] = useState(false);

  // Tapping a Version card in the message list (renderers/version-card.tsx)
  // should open this panel straight to its History tab — see
  // chat-panel-context.tsx's file comment for why this needs a context
  // instead of a direct prop (the panel and the message list are siblings,
  // not parent/child).
  const { historyRequestNonce } = useChatPanel();
  useEffect(() => {
    if (historyRequestNonce > 0) setPreviewOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyRequestNonce]);

  // Reverted (2026-07-15, explicit user request: "no leave the preview
  // and the share") -- the immediately-preceding change had folded Share
  // and Preview into this same '...' menu too. User wants those two back
  // as standalone top-level buttons; only Favorite and Replay (the two
  // less-frequently-used actions from the original "header looks too
  // full" pass) stay tucked into the overflow menu.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [moreOpen]);

  // Always running (2026-07-11, explicit user request: "not when I click
  // preview should it be stating [the error]") -- mounted here rather than
  // inside ChatPreviewPanel itself so a broken preview gets noticed and
  // auto-fixed whether or not the user ever opens the panel, not only the
  // moment they happen to click "Preview". See that hook's own comment for
  // the full self-heal-then-escalate-to-the-agent behavior.
  const preview = usePreviewAutoFix(sessionId);

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
    <div className="h-15 border-b border-border px-4 flex items-center justify-end">
      <div className="flex items-center gap-2">
        <button
          onClick={share}
          disabled={sharing}
          title="Create a public, view-only link anyone can open without signing in"
          className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-input bg-card hover:bg-accent transition-colors h-8 px-3 disabled:opacity-60"
        >
          {copied ? 'Link copied' : sharing ? 'Sharing…' : 'Share'}
        </button>
        <button
          onClick={() => setPreviewOpen(true)}
          title={
            preview.autoFixing
              ? "Preview isn't connecting — I've flagged it to the agent to fix"
              : "Preview your app, powered by this chat's sandbox"
          }
          className="relative inline-flex items-center justify-center rounded-md text-sm font-medium border border-input bg-card hover:bg-accent transition-colors h-8 px-3"
        >
          Preview
          {preview.autoFixing && (
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" aria-hidden="true" />
          )}
        </button>
        <div className="relative" ref={moreRef}>
          <button
            onClick={() => setMoreOpen(v => !v)}
            title="More actions"
            className={cn(
              'w-8 h-8 rounded-md flex items-center justify-center hover:bg-accent transition-colors',
              moreOpen && 'bg-accent'
            )}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </button>
          {moreOpen && (
            <div className="absolute right-0 top-9 z-20 w-44 rounded-md border border-border bg-card shadow-lg py-1">
              <button
                onClick={() => {
                  toggle();
                  setMoreOpen(false);
                }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-accent transition-colors',
                  isFav && 'text-primary'
                )}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                {isFav ? 'Remove from favorites' : 'Add to favorites'}
              </button>
              <Link
                href={`/chats/${sessionId}/playback`}
                onClick={() => setMoreOpen(false)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-accent transition-colors text-foreground"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    fill="currentColor"
                    fillRule="evenodd"
                    d="M12.5 3.75a7.75 7.75 0 0 0-7.022 11.033.85.85 0 0 1 .068.5l-.634 3.805 3.804-.634a.85.85 0 0 1 .5.068A7.75 7.75 0 1 0 12.5 3.75M3.25 11.5a9.25 9.25 0 1 1 5.517 8.466l-4.506.75a.85.85 0 0 1-.978-.977l.751-4.506A9.2 9.2 0 0 1 3.25 11.5"
                    clipRule="evenodd"
                  />
                </svg>
                Replay this chat
              </Link>
            </div>
          )}
        </div>
      </div>
      {previewOpen && (
        <ChatPreviewPanel
          sessionId={sessionId}
          state={preview.state}
          autoFixing={preview.autoFixing}
          onManualRestart={preview.manualRestart}
          onRefresh={preview.refresh}
          onClose={() => setPreviewOpen(false)}
          jumpToHistoryNonce={historyRequestNonce}
        />
      )}
    </div>
  );
}
