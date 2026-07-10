'use client';

/**
 * Direct-model chat — mounted instead of the eve-backed ChatInterfaceInner
 * whenever the selected/resumed model is an explicit pick (BYOK or a
 * Gateway slug — see chat-interface.tsx's isDirect branch). Talks to
 * /api/direct/chat only; never touches eve for the turn itself. Renamed
 * (2026-07-10) from the BYOK-only ByokChatInterface once Gateway picks
 * were moved to the same bypass — see that route's file comment for why.
 *
 * Deliberately a separate, simpler component rather than forcing eve's
 * EveMessage-shaped MessageRenderer to also understand plain AI-SDK
 * UIMessages — the two message shapes are different enough (EveMessage's
 * parts vocabulary vs UIMessage's) that a shared renderer would need its
 * own translation layer for marginal reuse benefit. Reasoning rendering
 * DOES reuse eve's own AIReasoningCard component though — same visual
 * language, no reason to duplicate it.
 */
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MarkdownText } from '@/components/ui/markdown';
import { ChatInput } from './chat-input';
import { AIReasoningCard } from './renderers/ai-reasoning-card';
import type { AttachedContext } from './chat-context';
import type { ReasoningEffort } from './chat-config';

interface DirectChatInterfaceProps {
  sessionId?: string;
  /** Exactly one of these two is set. */
  byokModelId?: string;
  requestedModel?: string;
  model: string;
  setModel: (model: string) => void;
  reasoningEffort?: ReasoningEffort;
  setReasoningEffort?: (level: ReasoningEffort) => void;
  placeholder?: string;
  placeholderTitle?: string;
  className?: string;
  headerContent?: React.ReactNode;
  initialMessage?: string;
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground py-1">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.2s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.1s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" />
    </div>
  );
}

export function DirectChatInterface({
  sessionId,
  byokModelId,
  requestedModel,
  model,
  setModel,
  reasoningEffort,
  setReasoningEffort,
  placeholder = 'What are your thoughts?',
  placeholderTitle = 'What can I help you with?',
  className = '',
  headerContent,
  initialMessage,
}: DirectChatInterfaceProps) {
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
        api: '/api/direct/chat',
        body: byokModelId ? { byokModelId, reasoningEffort } : { requestedModel, reasoningEffort },
      }),
    [byokModelId, requestedModel, reasoningEffort]
  );

  const chat = useChat({
    id: sessionId,
    messages: initialMessages ?? [],
    transport,
    onError(error) {
      console.error('[direct chat turn error]', error);
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
  const lastMessage = messages[messages.length - 1];
  // "Thinking…" indicator: visible from the moment a message is sent until
  // the assistant's reply actually has SOMETHING to show (text, a tool
  // call, or reasoning) — covers response latency, then gets out of the
  // way the instant real content starts arriving.
  const showThinkingIndicator =
    isBusy && (!lastMessage || lastMessage.role !== 'assistant' || lastMessage.parts.length === 0);

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
  }, [messages.length, showThinkingIndicator]);

  const onSend = (input: string, opts?: { attached?: AttachedContext[]; disabledTools?: string[]; model?: string }) => {
    // Switching to a different model mid-chat is handled by the parent
    // (chat-interface.tsx remounts into the right path); here we only ever
    // send under the current byokModelId/requestedModel.
    setTurnError(null);
    void chat.sendMessage({ text: input }).catch(err => {
      console.error('[direct chat send failed]', err);
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
        <ChatInput onSend={onSend} placeholder={placeholder} sending={isBusy} model={model} onModelChange={setModel} reasoningEffort={reasoningEffort} onReasoningEffortChange={setReasoningEffort} />
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
            {messages.map((m, mi) => {
              const isLastAssistant = mi === messages.length - 1 && m.role === 'assistant';
              return (
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
                      if (part.type === 'reasoning') {
                        const stillThinking = isLastAssistant && isBusy && i === m.parts.length - 1;
                        return <AIReasoningCard key={i} text={(part as any).text ?? ''} loading={stillThinking} />;
                      }
                      if (part.type.startsWith('tool-')) {
                        const state = 'state' in part ? (part as any).state : undefined;
                        const isError = state === 'output-error';
                        const errorText = isError ? ((part as any).errorText ?? 'Tool call failed.') : undefined;
                        return (
                          <div
                            key={i}
                            className={
                              isError
                                ? 'text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-2 py-1.5 my-1'
                                : 'text-xs text-muted-foreground bg-muted/50 rounded-md px-2 py-1 my-1 font-mono'
                            }
                          >
                            <div>
                              {part.type.replace('tool-', '')} {state ? `· ${state}` : ''}
                            </div>
                            {isError && <div className="mt-0.5 font-sans">{errorText}</div>}
                          </div>
                        );
                      }
                      return null;
                    })}
                    {isLastAssistant && showThinkingIndicator && <ThinkingIndicator />}
                  </div>
                </div>
              );
            })}
            {showThinkingIndicator && (!lastMessage || lastMessage.role !== 'assistant') && (
              <div className="flex justify-start">
                <ThinkingIndicator />
              </div>
            )}
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
          reasoningEffort={reasoningEffort}
          onReasoningEffortChange={setReasoningEffort}
        />
      </div>
    </div>
  );
}
