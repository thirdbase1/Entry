'use client';

/**
 * Public, unauthenticated share-link viewer — closes the real gap flagged
 * in an earlier session: the original's `/playback` route was genuinely
 * public with no auth, but this repo had no persisted "may anyone view
 * this" bit to gate that safely. `EveChatSession.isPublic`/`shareToken`
 * (schema.prisma) plus `/api/chats/public/[token]` (unauthenticated, looks
 * up by opaque token only — never sessionId/userId) now provide that.
 *
 * Lives outside the `(app)` route group deliberately, so it does NOT go
 * through that layout's auth redirect — anonymous visitors can load it.
 */
import { useEffect, useState } from 'react';
import { use } from 'react';
import Link from 'next/link';
import { ChatPlaybackView } from '@/components/chat/chat-playback-view';

async function fetchPublicSnapshot(token: string) {
  const res = await fetch(`/api/chats/public/${token}`);
  if (!res.ok) return null;
  return res.json() as Promise<{ events?: unknown; cursor?: unknown; title?: string | null }>;
}

export default function PublicSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [snapshot, setSnapshot] = useState<{ events?: unknown; cursor?: unknown; title?: string | null } | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchPublicSnapshot(token).then(snap => {
      if (!cancelled) setSnapshot(snap);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (snapshot === undefined) {
    return <div className="flex items-center justify-center h-screen text-muted-foreground text-sm">Loading…</div>;
  }
  if (!snapshot) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3 text-center px-4">
        <div className="text-sm text-muted-foreground">This shared chat link is invalid or no longer shared.</div>
        <Link href="/" className="text-sm text-primary hover:underline">
          Go to Entry
        </Link>
      </div>
    );
  }

  return (
    <div className="h-screen">
      <ChatPlaybackView initialEvents={snapshot.events} initialSession={snapshot.cursor} title={snapshot.title} publicMode />
    </div>
  );
}
