'use client';

import { useEveAgent } from 'eve/react';
import type { EveMessage, UseEveAgentSnapshot } from 'eve/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageRenderer } from './message-renderer';
import { ChatInput } from './chat-input';
import { resolveContextForSend, type AttachedContext } from './chat-context';
import { buildConfigContext, DEFAULT_MODEL_ID } from './chat-config';
import { DownArrow, type DownArrowRef } from './chat-arrow';
import { AggregatedTodoList } from './aggregated-todo-list';
import { ByokChatInterface } from './byok-chat-interface';

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
  return res.json() as Promise<{ events?: unknown; cursor?: unknown; byokModelId?: string | null }>;
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
  const [initial, setInitial] = useState<{ events?: unknown; cursor?: unknown; byokModelId?: string | null } | null>(
    sessionId ? null : {}
  );
  const createdRef = useRef(false);

  // Model selection lives here (not in ChatInput) so we can decide, before
  // ever mounting an eve session or a BYOK chat, which of the two mutually
  // exclusive runtimes this chat should use — see the isByok branch below.
  // Defaults to DEFAULT_MODEL_ID for a brand-new chat; set from the
  // resumed chat's stored byokModelId once the snapshot loads.
  const [model, setModel] = useState<string>(DEFAULT_MODEL_ID);
  const modelInitializedRef = useRef(false);

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

  useEffect(() => {
    if (modelInitializedRef.current) return;
    if (!initial) return;
    modelInitializedRef.current = true;
    if (initial.byokModelId) setModel(`byok:${initial.byokModelId}`);
  }, [initial]);

  if (!initial) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Loading conversation…
      </div>
    );
  }

  // A chat's runtime is decided ONCE and never hot-swapped mid-thread:
  // for a brand-new chat (no sessionId yet), whatever model is currently
  // selected when the first message is sent decides it. For a chat being
  // resumed, the runtime it was ALREADY created under (byokModelId stored
  // on the EveChatSession row) decides it, regardless of what the picker
  // shows right now — switching the picker mid-existing-eve-thread falls
  // back to the original clientContext-hint behavior (buildConfigContext)
  // rather than trying to migrate an eve event log into BYOK's plain
  // UIMessage[] shape (or vice versa), which are structurally different.
  const isByok = sessionId ? !!initial.byokModelId : model.startsWith('byok:');

  if (isByok) {
    return (
      <ByokChatInterface
        key={`byok-${sessionId ?? 'new'}`}
        sessionId={sessionId}
        byokModelId={model.slice('byok:'.length)}
        model={model}
        setModel={setModel}
        placeholder={placeholder}
        placeholderTitle={placeholderTitle}
        className={className}
        headerContent={headerContent}
        initialMessage={initialMessage}
      />
    );
  }

  return (
    <ChatInterfaceInner
      key={`eve-${sessionId ?? 'new'}`}
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
      model={model}
      setModel={setModel}
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
  model,
  setModel,
}: ChatInterfaceProps & {
  initialEvents?: any;
  initialSession?: any;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  createdRef: React.RefObject<boolean>;
  router: ReturnType<typeof useRouter>;
  model: string;
  setModel: (model: string) => void;
}) {
  // Turn-level failure banner. Without this, a turn that ends in
  // status "error" (e.g. run_model throwing because a BYOK provider
  // rejected the request, an invalid base URL, expired key, etc.)
  // renders literally NOTHING in the chat — no bubble, no error, just
  // silence. onError + the banner below are what was missing.
  const [turnError, setTurnError] = useState<string | null>(null);

  const agent = useEveAgent({
    initialEvents,
    initialSession,
    onError(error) {
      console.error('[eve turn error]', error);
      setTurnError(error.message || 'Something went wrong generating a response. Please try again.');
    },
    // onError above wraps eve's own `Error(event.data.message)` — but for
    // some failure shapes (e.g. Gateway errors) the actually-useful text
    // lives one level deeper at `event.data.details.message`, which that
    // top-level `.message` never captures (constructing `Error(undefined)`
    // -> an empty string, silently falling back to the generic banner
    // text below and hiding the real, actionable error — e.g. Vercel AI
    // Gateway's "Add credits at https://vercel.com/..." message never
    // reached the user). Read the raw stream event ourselves so the real
    // message always wins when it's present.
    onEvent(event) {
      if (event.type !== 'session.failed' && event.type !== 'turn.failed') return;
      const data = event.data as { message?: string; details?: { message?: string } };
      const real = data.details?.message ?? data.message;
      if (real) setTurnError(real);
    },
    async onFinish(snapshot) {
      setTurnError(null);
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
      setTurnError(null);
      void (async () => {
        const [attachedContext, configHint] = await Promise.all([
          resolveContextForSend(opts?.attached ?? []),
          Promise.resolve(buildConfigContext(opts?.model ?? '', opts?.disabledTools ?? [])),
        ]);
        const clientContext = [attachedContext, configHint].filter(Boolean).join('\n\n') || undefined;
        await agent.send({ message: input, clientContext }).catch(err => {
          // agent.send rejects when a turn is already in flight, or on a
          // pre-flight failure before any stream event arrives — onError
          // above covers mid-stream failures, this covers that gap too.
          console.error('[send failed]', err);
          setTurnError(err instanceof Error ? err.message : 'Failed to send message. Please try again.');
        });
      })();
    },
    [agent]
  );

  if (messages.length === 0 && !isBusy) {
    return (
      <div className="flex flex-col justify-center h-full p-4 gap-4 max-w-[800px] mx-auto">
        <div className="text-[26px] font-medium text-center mb-9 text-foreground">{placeholderTitle}</div>
        <ChatInput onSend={onSend} placeholder={placeholder} sending={isBusy} initialAttached={initialAttachedContext} model={model} onModelChange={setModel} />
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
      {turnError && (
        <div className="max-w-[832px] mx-auto w-full px-4">
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {turnError}
          </div>
        </div>
      )}
      <div className="sticky bottom-0 z-10 w-full bg-background max-w-[832px] px-4 mx-auto py-4">
        <ChatInput onSend={onSend} sending={isBusy} streaming={agent.status === 'streaming'} onAbort={agent.stop} placeholder={placeholder} initialAttached={initialAttachedContext} model={model} onModelChange={setModel} />
      </div>
    </div>
  );
}
