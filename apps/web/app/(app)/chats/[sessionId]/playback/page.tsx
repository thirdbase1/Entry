'use client';

/**
 * Chat playback — replays a finished chat's messages one at a time.
 * "Replay my own chat" view (auth-gated, same access scope as the regular
 * chat page). See app/share/[token]/page.tsx for the genuinely public,
 * unauthenticated share-link viewer (isPublic/shareToken schema fields on
 * EveChatSession) — that gap flagged in an earlier session is now closed.
 *
 * Also simplified vs. the original: replays whole messages one at a time
 * (a timer reveals one more item from the already-fetched, already-reduced
 * message list) rather than the original's character-level `streamMessages`
 * generator — same visual effect of "watching the conversation happen
 * again," lighter implementation. Countdown-overlay chrome dropped
 * (low-value polish).
 */
import { useEffect, useState } from 'react';
import { use } from 'react';
import { ChatPlaybackView } from '@/components/chat/chat-playback-view';

async function fetchSnapshot(sessionId: string) {
  const res = await fetch(`/api/chats/${sessionId}`);
  if (!res.ok) return null;
  return res.json() as Promise<{ events?: unknown; cursor?: unknown; title?: string }>;
}

export default function ChatPlaybackPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const [snapshot, setSnapshot] = useState<{ events?: unknown; cursor?: unknown; title?: string } | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchSnapshot(sessionId).then(snap => {
      if (!cancelled) setSnapshot(snap);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (snapshot === undefined) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>;
  }
  if (!snapshot) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Chat not found</div>;
  }

  return (
    <div className="flex-1 panel h-full">
      <ChatPlaybackView
        initialEvents={snapshot.events}
        initialSession={snapshot.cursor}
        title={snapshot.title}
        backHref={`/chats/${sessionId}`}
      />
    </div>
  );
}
