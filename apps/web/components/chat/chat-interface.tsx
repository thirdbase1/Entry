'use client';

import { useEveAgent } from 'eve/react';
import type { EveMessage, UseEveAgentSnapshot } from 'eve/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageRenderer } from './message-renderer';
import { ChatInput } from './chat-input';
import { resolveContextForSend, type AttachedContext } from './chat-context';
import { buildConfigContext, DEFAULT_MODEL_ID, useReasoningEffort } from './chat-config';
import { DownArrow, type DownArrowRef } from './chat-arrow';
import { AggregatedTodoList } from './aggregated-todo-list';
import { DirectChatInterface } from './direct-chat-interface';

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

/** localStorage key for the user's last-selected model, so a BYOK choice
 *  (or any model choice) persists across brand-new chats instead of
 *  resetting to the default every time. */
const LAST_MODEL_STORAGE_KEY = 'entry:lastSelectedModel';

async function fetchSnapshot(sessionId: string) {
  const res = await fetch(`/api/chats/${sessionId}`);
  if (!res.ok) return null;
  return res.json() as Promise<{ events?: unknown; cursor?: unknown; byokModelId?: string | null; requestedModel?: string | null }>;
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
  const [initial, setInitial] = useState<{ events?: unknown; cursor?: unknown; byokModelId?: string | null; requestedModel?: string | null } | null>(
    sessionId ? null : {}
  );
  const createdRef = useRef(false);
  const [recoveryKey, setRecoveryKey] = useState(0);
  // Live eve session id, lifted up from ChatInterfaceInner's `agent.session`
  // as soon as eve itself confirms it -- populated well before the route's
  // own `sessionId` prop (which only exists after the FIRST turn's onFinish
  // already ran + router.replace() landed). Without this, the two recovery
  // effects below were gated on `sessionId` alone, so a dropped connection
  // during a brand-new chat's very first turn -- arguably the single most
  // exposed moment, since the user just fired a message and may switch
  // away or lose signal immediately after -- silently recovered nothing at
  // all. Confirmed real (not hypothetical): direct-chat-interface.tsx had
  // the identical class of bug already found and fixed for the BYOK/direct
  // path (see its own comment); this is the same gap in the eve/default
  // path, closed the same way -- key off whichever id is known, not just
  // the one the URL happens to reflect yet.
  const [liveSessionId, setLiveSessionId] = useState<string | undefined>(undefined);

  // Model selection lives here (not in ChatInput) so we can decide, before
  // ever mounting an eve session or a direct-model chat, which of the two
  // mutually exclusive runtimes this chat should use — see the isDirect
  // branch below.
  // For a brand-new chat, initializes from the user's last-used model
  // (persisted in localStorage) instead of always falling back to
  // DEFAULT_MODEL_ID — otherwise a BYOK selection "didn't stick": every
  // new chat silently reverted to the default gateway model even though
  // the BYOK provider/key itself was still saved server-side. A resumed
  // chat still gets overridden from its stored byokModelId below, same
  // as before.
  const [model, setModelState] = useState<string>(() => {
    if (sessionId) return DEFAULT_MODEL_ID;
    if (typeof window === 'undefined') return DEFAULT_MODEL_ID;
    try {
      return window.localStorage.getItem(LAST_MODEL_STORAGE_KEY) || DEFAULT_MODEL_ID;
    } catch {
      return DEFAULT_MODEL_ID;
    }
  });
  const setModel = useCallback((next: string) => {
    setModelState(next);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LAST_MODEL_STORAGE_KEY, next);
    } catch {
      // localStorage can throw in private-browsing/quota-exceeded cases —
      // persistence is a nice-to-have, never worth crashing the chat over.
    }
  }, []);
  const [reasoningEffort, setReasoningEffort] = useReasoningEffort();
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

  // Belt-and-suspenders recovery for eve's own path, mirroring the fix
  // already shipped for the direct/BYOK path (direct-chat-interface.tsx).
  // eve/react's client DOES already auto-reconnect a broken mid-stream
  // connection on its own (up to `maxReconnectAttempts`, resuming from the
  // last event index rather than restarting -- see node_modules/eve/dist/
  // src/client/open-stream.js) so brief blips are already handled with no
  // app code needed. But confirmed by reading eve-agent-store.js directly:
  // once reconnect attempts are EXHAUSTED, the store's send() loop exits
  // its `for await` normally (the generator just returns instead of
  // throwing) and sets status to `'ready'` -- NOT `'error'` -- meaning a
  // turn truncated by a long-enough outage looks IDENTICAL to a cleanly
  // finished one from the outside. Status alone can't detect that case, so
  // this compares actual persisted event counts instead: whenever the tab
  // regains focus/network, refetch the server's authoritative snapshot,
  // and if it has strictly more events than what's currently rendered,
  // force a full remount of ChatInterfaceInner with the fresh snapshot
  // (bumping `recoveryKey`, since useEveAgent's initialEvents/initialSession
  // are only ever read once at construction -- there's no public API to
  // hot-patch an existing instance's projected state).
  useEffect(() => {
    const activeId = sessionId ?? liveSessionId;
    if (!activeId) return;
    const tryRecover = () => {
      void (async () => {
        const snap = await fetchSnapshot(activeId);
        const persistedEvents = Array.isArray(snap?.events) ? (snap!.events as unknown[]) : null;
        const currentEvents = Array.isArray(initial?.events) ? (initial!.events as unknown[]) : [];
        if (!persistedEvents) return;
        if (persistedEvents.length > currentEvents.length) {
          setInitial(snap ?? {});
          setRecoveryKey(k => k + 1);
          // Mirror onFinish's own first-turn navigation: if the client's
          // onFinish never got to run (the stream broke before it could
          // fire), the URL would otherwise be stuck on the "new chat"
          // route forever despite the chat now genuinely being persisted
          // under `activeId`.
          if (!createdRef.current) {
            createdRef.current = true;
            if (!sessionId) router.replace(`/chats/${activeId}`);
          }
        }
      })();
    };
    const onOnline = () => tryRecover();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tryRecover();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    // Belt-and-suspenders third trigger, independent of the browser
    // actually firing 'online'/'visibilitychange' at all -- see the same
    // comment in direct-chat-interface.tsx's identical recovery effect
    // for why relying solely on those two DOM events isn't enough.
    const pollId = window.setInterval(tryRecover, 5000);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(pollId);
    };
  }, [sessionId, liveSessionId, initial, router, createdRef]);

  useEffect(() => {
    if (modelInitializedRef.current) return;
    if (!initial) return;
    modelInitializedRef.current = true;
    if (initial.byokModelId) setModel(`byok:${initial.byokModelId}`);
    else if (initial.requestedModel) setModel(`gateway:${initial.requestedModel}`);
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
  // resumed, the runtime it was ALREADY created under (byokModelId or
  // requestedModel stored on the EveChatSession row) decides it,
  // regardless of what the picker shows right now.
  //
  // ANY explicit model pick — BYOK or a Gateway slug — now bypasses eve
  // entirely via DirectChatInterface (see apps/web/app/api/direct/chat's
  // file comment for why: eve's root agent used to be a mandatory,
  // non-streaming, identity-leaking relay in front of every picked model).
  // Only "Default" (no pick) still goes to eve's own ChatInterfaceInner.
  const isDirect = sessionId
    ? !!(initial.byokModelId || initial.requestedModel)
    : model.startsWith('byok:') || model.startsWith('gateway:');

  if (isDirect) {
    const byokModelId = sessionId ? initial.byokModelId ?? undefined : model.startsWith('byok:') ? model.slice('byok:'.length) : undefined;
    const requestedModel = sessionId
      ? initial.requestedModel ?? undefined
      : model.startsWith('gateway:')
        ? model.slice('gateway:'.length)
        : undefined;
    return (
      <DirectChatInterface
        key={`direct-${sessionId ?? 'new'}`}
        sessionId={sessionId}
        byokModelId={byokModelId}
        requestedModel={requestedModel}
        model={model}
        setModel={setModel}
        reasoningEffort={reasoningEffort}
        setReasoningEffort={setReasoningEffort}
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
      key={`eve-${sessionId ?? 'new'}-${recoveryKey}`}
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
      onSessionIdKnown={setLiveSessionId}
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
  onSessionIdKnown,
}: ChatInterfaceProps & {
  initialEvents?: any;
  initialSession?: any;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  createdRef: React.RefObject<boolean>;
  router: ReturnType<typeof useRouter>;
  model: string;
  setModel: (model: string) => void;
  /** Reports eve's live session id up to the parent as soon as it's known
   *  (well before the route `sessionId` prop reflects it) so the parent's
   *  recovery effect can key off it too — see the `liveSessionId` comment
   *  above. */
  onSessionIdKnown: (sessionId: string | undefined) => void;
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
    // Default is 3 -- fine for a flaky packet or two, not enough for a
    // backgrounded mobile tab (routinely suspended for way longer than 3
    // quick reconnect attempts can cover) or a real network drop of more
    // than a few seconds. Each attempt just reopens the stream from the
    // last received index (see open-stream.js) -- cheap to retry more.
    // The chat-interface.tsx-level recovery effect above is the fallback
    // for outages long enough to exhaust even this.
    maxReconnectAttempts: 20,
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

  // Report eve's live session id up to the parent AS SOON as eve confirms
  // it (agent.session is eve's own "resumable cursor", populated once the
  // stream confirms the session -- well before this turn's onFinish, and
  // well before the route ever reflects it via router.replace). This is
  // what lets the parent's recovery effect key off a real id during a
  // brand-new chat's very first turn instead of sitting dark until that
  // turn already fully finished client-side.
  useEffect(() => {
    onSessionIdKnown(agent.session?.sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.session?.sessionId]);

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
