'use client';

/**
 * Ported 1:1 from pages/onboarding/show-case.tsx.
 * Playback showcase grid — 6 example chat playback thumbnails that open
 * in a modal when clicked, showing a replay of an example chat session.
 *
 * Uses framer-motion layout animations for the thumbnail-to-modal transition
 * (same as the original). The modal plays back /playbacks/example-playback.json
 * via our ChatPlaybackView component.
 *
 * example-playback.json is a flat array of legacy `{ role, content }` chat
 * messages (the original app's on-disk shape) — not eve's stream-event log.
 * `legacyMessagesToEveEvents` adapts it into the minimal eve
 * `message.received` / `message.completed` event pair ChatPlaybackView (and
 * the eve reducer it feeds) actually expects, so this stays a pure static
 * replay without needing a live eve session or a real protocol port of
 * tool-call/streamObjects visualization (this is decorative onboarding
 * content, not a real chat).
 */
import { motion, LayoutGroup, AnimatePresence } from 'framer-motion';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';
import { ChatPlaybackView } from '@/components/chat/chat-playback-view';

type LegacyPlaybackMessage = {
  id: string;
  role: string;
  content: string | null;
  createdAt: string;
};

function legacyMessagesToEveEvents(messages: LegacyPlaybackMessage[]) {
  const events: unknown[] = [];
  let sequence = 0;
  const turnId = 'showcase-turn';

  for (const message of messages) {
    if (message.role === 'user') {
      events.push({
        type: 'message.received',
        data: { message: message.content ?? '', sequence: sequence++, turnId },
      });
    } else {
      events.push({
        type: 'message.completed',
        data: {
          message: message.content ?? '',
          finishReason: 'stop',
          sequence: sequence++,
          stepIndex: 0,
          turnId,
        },
      });
    }
  }

  return events;
}

const playbacks = [
  {
    id: '1',
    url: '/playbacks/example-playback.json',
    title: 'Discover the Art of Meaningful Conversations: Tips and Tricks for Creating Engaging and Memorable Chat Experiences with Friends!',
  },
  {
    id: '2',
    url: '/playbacks/example-playback.json',
    title: 'Discover the Art of Meaningful Conversations: Tips and Tricks for Creating Engaging and Memorable Chat Experiences with Friends!',
  },
  {
    id: '3',
    url: '/playbacks/example-playback.json',
    title: 'Discover the Art of Meaningful Conversations: Tips and Tricks for Creating Engaging and Memorable Chat Experiences with Friends!',
  },
  {
    id: '4',
    url: '/playbacks/example-playback.json',
    title: 'Discover the Art of Meaningful Conversations: Tips and Tricks for Creating Engaging and Memorable Chat Experiences with Friends!',
  },
  {
    id: '5',
    url: '/playbacks/example-playback.json',
    title: 'Discover the Art of Meaningful Conversations: Tips and Tricks for Creating Engaging and Memorable Chat Experiences with Friends!',
  },
  {
    id: '6',
    url: '/playbacks/example-playback.json',
    title: 'Discover the Art of Meaningful Conversations: Tips and Tricks for Creating Engaging and Memorable Chat Experiences with Friends!',
  },
];

function PlayFillIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function ExamplePlayback({ url }: { url: string }) {
  const [events, setEvents] = useState<unknown[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(res => res.json())
      .then((messages: LegacyPlaybackMessage[]) => {
        if (!cancelled) setEvents(legacyMessagesToEveEvents(messages));
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!events) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return <ChatPlaybackView initialEvents={events} initialSession={undefined} publicMode />;
}

export function ShowCase() {
  const [activeId, setActiveId] = useState<string | null>(null);

  const show = (id: string) => setActiveId(id);
  const hide = () => setActiveId(null);

  return (
    <>
      <div className="max-w-[860px] px-4 grid grid-cols-3 gap-4">
        {playbacks.map(playback => (
          <LayoutGroup key={playback.id}>
            <div className="playback-item flex flex-col gap-2 p-1">
              <div className="relative w-full h-[158px] rounded-lg overflow-hidden group">
                {activeId === playback.id ? null : (
                  <motion.div
                    layout
                    layoutId={`playback-thumb-${playback.id}`}
                    className="playback-thumb size-full rounded-lg bg-muted"
                  />
                )}
                <div
                  className={cn(
                    'absolute size-full left-0 top-0',
                    'rounded-lg flex items-center justify-center',
                    'opacity-0 group-hover:opacity-100 transition-opacity duration-300 group-hover:bg-black/20'
                  )}
                >
                  <div
                    className={cn(
                      'flex items-center justify-center',
                      'size-11 rounded-full cursor-pointer',
                      'transition-all',
                      'bg-white/30 hover:bg-white/50'
                    )}
                    onClick={() => show(playback.id)}
                  >
                    <PlayFillIcon className="text-2xl text-white translate-x-[2px]" />
                  </div>
                </div>
              </div>
              <div className="text-[15px] text-foreground truncate">
                {playback.title}
              </div>
            </div>
          </LayoutGroup>
        ))}
      </div>

      {/* Modal */}
      <AnimatePresence>
        {activeId ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            onClick={hide}
          >
            <motion.div
              layoutId={`playback-thumb-${activeId}`}
              className="bg-card rounded-lg overflow-hidden flex flex-col"
              style={{ maxWidth: '1080px', maxHeight: '860px', width: '90%', height: '90%' }}
              onClick={e => e.stopPropagation()}
            >
              <header className="truncate flex items-center justify-between p-4 border-b">
                {playbacks.find(p => p.id === activeId)?.title}
                <button onClick={hide} className="ml-4 text-muted-foreground hover:text-foreground">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </header>
              <main className="rounded-lg h-0 flex-1 overflow-hidden">
                <ExamplePlayback url={playbacks.find(p => p.id === activeId)?.url ?? ''} />
              </main>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
