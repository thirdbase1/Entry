'use client';

/**
 * BYOK-direct chat — mounted instead of the eve-backed ChatInterfaceInner
 * whenever the selected/resumed model is a BYOK one (see chat-interface.tsx's
 * isByok branch). Talks to /api/byok/chat only; never touches eve or
 * Vercel AI Gateway. Deliberately a separate, simpler component rather than
 * forcing eve's EveMessage-shaped MessageRenderer to also understand plain
 * AI-SDK UIMessages — the two message shapes are different enough
 * (EveMessage's parts vocabulary vs UIMessage's) that a shared renderer
 * would need its own translation layer for marginal reuse benefit.
 */
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MarkdownText } from '@/components/ui/markdown';
import { ChatInput } from './chat-input';
import type { AttachedContext } from './chat-context';

interface ByokChatInterfaceProps {
  sessionId?: string;
  byokModelId: string;
  model: string;
  setModel: (model: string) => void;
  placeholder?: string;
  placeholderTitle?: string;
  className?: string;
  headerContent?: React.ReactNode;
  initialMessage?: string;
}

export function ByokChatInterface({
  sessionId,
  byokModelId,
  model,
  setModel,
  placeholder = 'What are your thoughts?',
  placeholderTitle = 'What can I help you with?',
  className = '',
  headerContent,
  initialMessage,
}: ByokChatInterfaceProps) {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const createdRef = useRef(!!sessionId);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<any[] | null>(sessionId ? null : []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetch(`/api/chats/${sessionId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(snap => {
        if (!cancelled) setInitialMessages(Array.isArray(snap?.events) ? snap.events : []);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/byok/chat',
        body: { byokModelId },
      }),
    [byokModelId]
  );

  const chat = useChat({
    id: sessionId,
    messages: initialMessages ?? [],
    transport,
    onError(error) {
      console.error('[byok turn error]', error);
      setTurnError(error.message || 'Something went wrong generating a response. Please try again.');
    },
    async onFinish() {
      setTurnError(null);
      if (!createdRef.current) {
        createdRef.current = true;
        if (!sessionId) router.replace(`/chats/${chat.id}`);
      }
    },
  });

  const isBusy = chat.status === 'submitted' || chat.status === 'streaming';
  const messages = chat.messages;

  const sentInitialRef = useRef(false);
  useEffect(() => {
    if (initialMessage && !sentInitialRef.current && initialMessages && initialMessages.length === 0) {
      sentInitialRef.current = true;
      void chat.sendMessage({ text: initialMessage });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, initialMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  const onSend = (input: string, opts?: { attached?: AttachedContext[]; disabledTools?: string[]; model?: string }) => {
    // Switching to a different (non-BYOK) model mid-chat is handled by the
    // parent (chat-interface.tsx remounts into the eve path); here we only
    // ever send under the current byokModelId.
    setTurnError(null);
    void chat.sendMessage({ text: input }).catch(err => {
      console.error('[byok send failed]', err);
      setTurnError(err instanceof Error ? err.message : 'Failed to send message. Please try again.');
    });
  };

  if (initialMessages === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Loading conversation…
      </div>
    );
  }

  if (messages.length === 0 && !isBusy) {
    return (
      <div className="flex flex-col justify-center h-full p-4 gap-4 max-w-[800px] mx-auto">
        <div className="text-[26px] font-medium text-center mb-9 text-foreground">{placeholderTitle}</div>
        <ChatInput onSend={onSend} placeholder={placeholder} sending={isBusy} model={model} onModelChange={setModel} />
        {turnError && (
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2 text-center">
            {turnError}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {headerContent}
      <div className="flex-1 h-0 flex flex-col relative">
        <div ref={scrollRef} className="flex-1 overflow-y-auto py-4">
          <div className="max-w-[832px] mx-auto px-4 w-full flex flex-col [&>*:not(:first-child)]:mt-4">
            {messages.map(m => (
              <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={
                    m.role === 'user'
                      ? 'max-w-[80%] rounded-2xl bg-primary text-primary-foreground px-4 py-2.5 text-sm'
                      : 'max-w-[90%] text-sm text-foreground'
                  }
                >
                  {m.parts.map((part, i) => {
                    if (part.type === 'text') return <MarkdownText key={i} text={part.text} />;
                    if (part.type.startsWith('tool-')) {
                      return (
                        <div key={i} className="text-xs text-muted-foreground bg-muted/50 rounded-md px-2 py-1 my-1 font-mono">
                          {part.type.replace('tool-', '')} {'state' in part ? `· ${(part as any).state}` : ''}
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {turnError && (
        <div className="max-w-[832px] mx-auto w-full px-4">
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {turnError}
          </div>
        </div>
      )}
      <div className="max-w-[832px] px-4 mx-auto w-full py-4">
        <ChatInput
          onSend={onSend}
          sending={isBusy}
          streaming={chat.status === 'streaming'}
          onAbort={chat.stop}
          placeholder={placeholder}
          model={model}
          onModelChange={setModel}
        />
      </div>
    </div>
  );
}
