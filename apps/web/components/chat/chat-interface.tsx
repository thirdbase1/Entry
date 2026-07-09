'use client';

import { useEveAgent } from 'eve/react';
import type { EveMessage, UseEveAgentSnapshot } from 'eve/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageRenderer } from './message-renderer';
import { ChatInput } from './chat-input';
import { resolveContextForSend, type AttachedContext } from './chat-context';
import { buildConfigContext } from './chat-config';
import { DownArrow, type DownArrowRef } from './chat-arrow';
import { AggregatedTodoList } from './aggregated-todo-list';

interface ChatInterfaceProps {
  /** Existing eve sessionId, if resuming a saved chat. */
  sessionId?: string;
  placeholder?: string;
  placeholderTitle?: string;
  className?: string;
  headerContent?: React.ReactNode;
  /** Initial message to send immediately (e.g. from a ?msg= query param). */
  initialMessage?: string;
  /** Pre-attached context (e.g. a doc, when opened from a doc's "chat about this" button). */
  initialAttachedContext?: import('./chat-context').AttachedContext[];
}

async function fetchSnapshot(sessionId: string) {
  const res = await fetch(`/api/chats/${sessionId}`);
  if (!res.ok) return null;
  return res.json() as Promise<{ events?: unknown; cursor?: unknown }>;
}

async function persistSnapshot(sessionId: string, snapshot: UseEveAgentSnapshot<{ messages: readonly EveMessage[] }>, title?: string) {
  await fetch(`/api/chats/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: snapshot.events, cursor: snapshot.session, title }),
  });
}

function deriveTitle(messages: readonly EveMessage[]): string | undefined {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return undefined;
  const text = firstUser.parts.find(p => p.type === 'text')?.text ?? '';
  return text.slice(0, 80) || undefined;
}

export function ChatInterface({
  sessionId,
  placeholder = 'What are your thoughts?',
  placeholderTitle = 'What can I help you with?',
  className = '',
  headerContent,
  initialMessage,
  initialAttachedContext,
}: ChatInterfaceProps) {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [initial, setInitial] = useState<{ events?: unknown; cursor?: unknown } | null>(
    sessionId ? null : {}
  );
  const createdRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchSnapshot(sessionId).then(snap => {
      if (!cancelled) setInitial(snap ?? {});
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!initial) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Loading conversation…
      </div>
    );
  }

  return (
    <ChatInterfaceInner
      key={sessionId ?? 'new'}
      sessionId={sessionId}
      initialEvents={initial.events as any}
      initialSession={initial.cursor as any}
      placeholder={placeholder}
      placeholderTitle={placeholderTitle}
      className={className}
      headerContent={headerContent}
      initialMessage={initialMessage}
      initialAttachedContext={initialAttachedContext}
      scrollRef={scrollRef}
      createdRef={createdRef}
      router={router}
    />
  );
}

function ChatInterfaceInner({
  sessionId,
  initialEvents,
  initialSession,
  placeholder,
  placeholderTitle,
  className,
  headerContent,
  initialMessage,
  initialAttachedContext,
  scrollRef,
  createdRef,
  router,
}: ChatInterfaceProps & {
  initialEvents?: any;
  initialSession?: any;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  createdRef: React.RefObject<boolean>;
  router: ReturnType<typeof useRouter>;
}) {
  const agent = useEveAgent({
    initialEvents,
    initialSession,
    async onFinish(snapshot) {
      const sid = snapshot.session?.sessionId;
      if (!sid) return;
      const title = deriveTitle(snapshot.data.messages);
      if (!createdRef.current) {
        createdRef.current = true;
        await fetch('/api/chats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, title }),
        }).catch(() => {});
        if (!sessionId) {
          router.replace(`/chats/${sid}`);
        }
      }
      await persistSnapshot(sid, snapshot, title).catch(() => {});
    },
  });

  const isBusy = agent.status === 'submitted' || agent.status === 'streaming';
  const messages = agent.data.messages;
  const downArrowRef = useRef<DownArrowRef>(null);
  const [showArrow, setShowArrow] = useState(false);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [scrollRef]);

  // Auto-scroll on new messages, and manage down-arrow visibility
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isAtBottom) {
      scrollToBottom();
      downArrowRef.current?.hide();
    } else {
      downArrowRef.current?.show();
    }
  }, [messages.length, scrollToBottom]);

  // Track scroll position to show/hide down arrow
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      if (isAtBottom) {
        downArrowRef.current?.hide();
      } else {
        downArrowRef.current?.show();
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  const sentInitialRef = useRef(false);
  useEffect(() => {
    if (initialMessage && !sentInitialRef.current && messages.length === 0) {
      sentInitialRef.current = true;
      void agent.send({ message: initialMessage });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage]);

  const onSend = useCallback(
    (input: string, opts?: { attached?: AttachedContext[]; disabledTools?: string[]; model?: string }) => {
      void (async () => {
        const [attachedContext, configHint] = await Promise.all([
          resolveContextForSend(opts?.attached ?? []),
          Promise.resolve(buildConfigContext(opts?.model ?? '', opts?.disabledTools ?? [])),
        ]);
        const clientContext = [attachedContext, configHint].filter(Boolean).join('\n\n') || undefined;
        await agent.send({ message: input, clientContext });
      })();
    },
    [agent]
  );

  if (messages.length === 0 && !isBusy) {
    return (
      <div className="flex flex-col justify-center h-full p-4 gap-4 max-w-[800px] mx-auto">
        <div className="text-[26px] font-medium text-center mb-9 text-foreground">{placeholderTitle}</div>
        <ChatInput onSend={onSend} placeholder={placeholder} sending={isBusy} initialAttached={initialAttachedContext} />
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {headerContent}
      <div className="flex-1 h-0 flex flex-col relative">
        <div ref={scrollRef} className="flex-1 overflow-y-auto py-4">
          <div className="max-w-[832px] mx-auto px-4 w-full flex flex-col [&>*:not(:first-child)]:mt-4">
            {messages.map((m, idx) => (
              <MessageRenderer
                key={m.id}
                message={m}
                isStreaming={isBusy && idx === messages.length - 1}
                allMessages={messages}
                onSend={onSend}
              />
            ))}
          </div>
        </div>
        <DownArrow
          ref={downArrowRef}
          onClick={scrollToBottom}
          loading={isBusy}
        />
      </div>
      <AggregatedTodoList messages={messages} />
      <div className="max-w-[832px] px-4 mx-auto w-full py-4">
        <ChatInput onSend={onSend} sending={isBusy} streaming={agent.status === 'streaming'} onAbort={agent.stop} placeholder={placeholder} initialAttached={initialAttachedContext} />
      </div>
    </div>
  );
}
