'use client';

/**
 * Shared chat-replay UI, used by both the authed "replay my own chat" page
 * (app/(app)/chats/[sessionId]/playback) and the public share page
 * (app/share/[token]) — same visual/behavioral contract for both, just a
 * different data-fetch + auth context around it. See either page for the
 * scope-cut notes (this is the piece that used to be duplicated).
 */
import { useEffect, useMemo, useState } from 'react';
import { useEveAgent } from 'eve/react';
import Link from 'next/link';
import { MessageRenderer } from '@/components/chat/message-renderer';

export function ChatPlaybackView({
  initialEvents,
  initialSession,
  title,
  backHref,
  publicMode,
}: {
  initialEvents: unknown;
  initialSession: unknown;
  title?: string | null;
  /** Shown as a "← Back to chat" link — omit for the public/anonymous viewer, which has no chat to go back to. */
  backHref?: string;
  /** Shows a "Shared chat — view only" badge instead of the back link. */
  publicMode?: boolean;
}) {
  const agent = useEveAgent({ initialEvents, initialSession } as any);
  const allMessages = agent.data.messages;

  const [revealCount, setRevealCount] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing || revealCount >= allMessages.length) return;
    const t = setTimeout(() => setRevealCount(c => c + 1), 700);
    return () => clearTimeout(t);
  }, [playing, revealCount, allMessages.length]);

  const visible = useMemo(() => allMessages.slice(0, revealCount), [allMessages, revealCount]);
  const finished = revealCount >= allMessages.length;

  return (
    <div className="flex flex-col h-full">
      <div className="h-15 border-b border-border px-4 flex items-center justify-between gap-4 shrink-0">
        {backHref ? (
          <Link href={backHref} className="text-sm text-muted-foreground hover:text-foreground shrink-0">
            ← Back to chat
          </Link>
        ) : (
          <span className="text-xs font-medium text-muted-foreground shrink-0 rounded-full border bg-muted px-2.5 py-1">
            Shared chat — view only
          </span>
        )}
        <div className="text-sm font-medium text-foreground truncate flex-1 text-center">{title ?? 'Replay'}</div>
        <div className="w-24 shrink-0" />
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-24">
        <div className="max-w-[800px] mx-auto w-full flex flex-col [&>*:not(:first-child)]:mt-4">
          {visible.map((m, idx) => (
            <MessageRenderer key={m.id ?? idx} message={m} isStreaming={!finished && idx === visible.length - 1 && m.role !== 'user'} />
          ))}
        </div>
      </div>

      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-full border bg-card text-card-foreground shadow-lg px-4 h-12">
        {!finished ? (
          <>
            <span className="text-sm text-muted-foreground">
              {playing ? 'Replaying…' : 'Paused'} ({revealCount}/{allMessages.length})
            </span>
            <button
              onClick={() => setPlaying(p => !p)}
              className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-input bg-card hover:bg-accent h-8 px-3"
            >
              {playing ? 'Pause' : 'Resume'}
            </button>
            <button
              onClick={() => setRevealCount(allMessages.length)}
              className="inline-flex items-center justify-center rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 h-8 px-3"
            >
              Skip to end
            </button>
          </>
        ) : (
          <>
            <span className="text-sm text-muted-foreground">Replay finished</span>
            <button
              onClick={() => {
                setPlaying(true);
                setRevealCount(0);
              }}
              className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-input bg-card hover:bg-accent h-8 px-3"
            >
              Watch again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
