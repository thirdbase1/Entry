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
 *
 * Split into two components (2026-07-11) after a confirmed, reproduced bug:
 * reopening an existing conversation always rendered as an empty/new chat.
 * Root cause, verified directly against @ai-sdk/react's useChat source
 * (node_modules/@ai-sdk/react/dist/index.js): useChat only constructs its
 * internal Chat instance (which is what `messages:` actually seeds) ONCE,
 * via `useRef(... new Chat(chatOptions))`, and only reconstructs it later
 * if `id` itself changes. Reopening a saved chat renders with a non-null
 * `id` (the sessionId) from the very first frame, while the actual message
 * history is fetched asynchronously — so by the time that fetch resolves,
 * `id` hasn't changed (it was already correct), useChat never reconstructs,
 * and the freshly-fetched history is silently discarded. The exact same
 * problem was already solved correctly one level up for the eve path (see
 * chat-interface.tsx: it never even renders `ChatInterfaceInner` — the one
 * that calls useEveAgent — until its own history fetch resolves), but this
 * component used to do its history fetch AND its useChat call in the same
 * component, so it never got that protection. Fix: this outer component
 * now ONLY resolves the initial message history and renders nothing that
 * calls useChat until that's done; `DirectChatSession` below is the one
 * that calls useChat, and it never mounts until history is guaranteed
 * resolved (keyed by sessionId so switching chats always gets a clean
 * remount too, not just a stale patched-over instance).
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
import { sendWithRetry, readableChatErrorMessage } from './send-with-retry';

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

/**
 * Outer shell: resolves the persisted message history (if resuming a
 * saved chat) BEFORE anything downstream ever calls useChat. Deliberately
 * does not itself hold any useChat/transport state — see file comment.
 */
export function DirectChatInterface(props: DirectChatInterfaceProps) {
  const { sessionId } = props;
  const [initialMessages, setInitialMessages] = useState<any[] | null>(sessionId ? null : []);

  useEffect(() => {
    if (!sessionId) return;
    setInitialMessages(null);
    let cancelled = false;
    fetch(`/api/chats/${sessionId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(snap => {
        if (!cancelled) setInitialMessages(Array.isArray(snap?.events) ? snap.events : []);
      })
      .catch(() => {
        if (!cancelled) setInitialMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (initialMessages === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Loading conversation…
      </div>
    );
  }

  // Keyed by sessionId: guarantees a full remount (fresh useChat Chat
  // instance) whenever we switch which conversation we're looking at,
  // instead of relying solely on useChat's own id-diff recreate logic.
  return <DirectChatSession key={sessionId ?? 'new'} {...props} initialMessages={initialMessages} />;
}

/**
 * Only ever mounted once `initialMessages` is already the real, resolved
 * history (or `[]` for a genuinely brand-new chat) — this is what makes
 * useChat's one-time Chat-instance construction correct every time.
 */
function DirectChatSession({
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
  initialMessages,
}: DirectChatInterfaceProps & { initialMessages: any[] }) {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const createdRef = useRef(!!sessionId);
  const [turnError, setTurnError] = useState<string | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/direct/chat',
        body: byokModelId ? { byokModelId, reasoningEffort } : { requestedModel, reasoningEffort },
      }),
    [byokModelId, requestedModel, reasoningEffort]
  );

  // (2026-07-11) Removed the "Running: <model>" label per explicit user
  // request ("remove that stuff that show what model is running, I don't
  // like it") — was previously shown above the chat input and in the
  // header bar, sourced from byokModelId/requestedModel via useModelOptions.
  const chat = useChat({
    id: sessionId,
    messages: initialMessages,
    transport,
    onError(error) {
      console.error('[direct chat turn error]', error);
      setTurnError(readableChatErrorMessage(error));
    },
    async onFinish() {
      setTurnError(null);
      if (!createdRef.current) {
        createdRef.current = true;
        if (!sessionId) router.replace(`/chats/${chat.id}`);
      }
    },
  });

  // Recover from a dropped connection instead of just sitting on a
  // stalled/errored turn forever. Two real, confirmed cases this covers:
  // (1) the user switches to another app/tab mid-turn -- mobile browsers
  // routinely suspend a backgrounded tab's network activity, which tears
  // down the in-flight fetch's stream; (2) the user's own network drops
  // outright. Neither should mean the work is lost: the server now keeps
  // the turn running to completion regardless of the client connection
  // (see route.ts's after()+consumeStream()) and persists the final
  // result, so once we're back, refetch the persisted session and adopt
  // it if it has more/different content than what we're stuck showing
  // locally -- turns a "stopped, no response" dead end into "oh, it
  // actually finished while I was away."
  useEffect(() => {
    const tryRecover = () => {
      void (async () => {
        // `chat.id` is always populated from the very first render (the AI
        // SDK's Chat class defaults it via generateId() when no `id` prop
        // is given -- confirmed directly in node_modules/ai/dist/index.js),
        // and that same id is what DefaultChatTransport sends as `id` in
        // the POST body, which route.ts then reuses as the persisted
        // chatId. So it's ALWAYS safe to key off chat.id, even for a
        // brand-new chat's very first message -- there is no window where
        // it's genuinely unknown. Previously this was gated behind
        // `createdRef.current` (only true AFTER the first turn's onFinish
        // already completed client-side), which meant a dropped connection
        // during exactly that first turn -- easily the single most likely
        // moment to lose network/backgrounding, since it's right when
        // someone fires off a message and switches away -- could never be
        // recovered at all: the gate itself silently withheld the one id
        // that was already valid and already matched what the server had
        // persisted under.
        const activeId = sessionId ?? chat.id;
        if (!activeId) return;
        // Confirmed real gap (2026-07-11): this used to bail out unless
        // `chat.status` was already 'streaming'/'submitted'/'error' -- but
        // status is a property of THIS component instance, reset to
        // 'ready' on every fresh mount (including a plain page reload).
        // A reload that happens WHILE a turn is still generating server-
        // side (kept alive by route.ts's after()+consumeStream() durability
        // fix) landed on a brand-new mount with status 'ready', so this
        // guard silently skipped recovery forever -- the one case it most
        // needed to run. Falling back to inspecting the actual message
        // shape catches that: the last message being from 'user' with no
        // assistant reply yet is exactly what an interrupted-mid-turn
        // reload looks like from a fresh mount, regardless of what
        // `chat.status` (re-)initialized to.
        const lastMsg = chat.messages[chat.messages.length - 1];
        const looksIncomplete = !lastMsg || lastMsg.role === 'user';
        if (chat.status !== 'streaming' && chat.status !== 'submitted' && chat.status !== 'error' && !looksIncomplete) return;
        try {
          const res = await fetch(`/api/chats/${activeId}`);
          if (!res.ok) return;
          const snap = await res.json();
          const persisted = Array.isArray(snap?.events) ? snap.events : null;
          if (!persisted || persisted.length === 0) return;
          if (persisted.length >= chat.messages.length) {
            chat.setMessages(persisted);
            setTurnError(null);
            chat.clearError();
            // Mirror onFinish's own first-turn navigation: if the client's
            // onFinish never got to run (the stream broke before it could
            // fire), the URL would otherwise be stuck on the "new chat"
            // route forever despite the chat now genuinely being persisted
            // under `activeId` -- a refresh later would lose it from view.
            if (!createdRef.current) {
              createdRef.current = true;
              if (!sessionId) router.replace(`/chats/${activeId}`);
            }
          }
        } catch {
          // best-effort -- retried on the next online/visibility event
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
    // actually firing 'online'/'visibilitychange' at all: some networks
    // drop/restore Wi-Fi or cellular without ever firing a real 'offline'
    // -> 'online' transition (silent DNS/route flap), and a laptop
    // sleep/wake cycle can resume with the tab still reporting 'visible'
    // the whole time. Poll every 3s while a turn looks active (or looks
    // interrupted-mid-turn on a fresh mount, see looksIncomplete above) so
    // a dead connection still self-heals even when neither event ever
    // fires -- cheap (one lightweight GET), and tryRecover() itself is a
    // no-op once nothing new is available. Also fire once immediately
    // (not just after the first interval tick) so a reload lands on an
    // up-to-date answer as fast as possible instead of waiting up to 3s
    // doing nothing first.
    tryRecover();
    const pollId = window.setInterval(tryRecover, 3000);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(pollId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, chat.id, chat.status]);

  const isBusy = chat.status === 'submitted' || chat.status === 'streaming';
  const messages = chat.messages;
  const lastMessage = messages[messages.length - 1];
  // True right after a fresh mount (e.g. a reload) that landed mid-turn --
  // the last thing in history is the user's own message with no assistant
  // reply after it yet, and this component instance's own `isBusy` says
  // nothing is happening (status resets to 'ready' on every fresh mount,
  // see the recovery effect's `looksIncomplete` comment above for why that
  // alone can't be trusted). Distinct from `showThinkingIndicator` below,
  // which only ever covers a turn that started IN this same instance.
  const pendingTurn = !isBusy && messages.length > 0 && lastMessage?.role === 'user';
  // "Thinking…" indicator: visible from the moment a message is sent until
  // the assistant's reply actually has SOMETHING to show (text, a tool
  // call, or reasoning) — covers response latency, then gets out of the
  // way the instant real content starts arriving.
  const showThinkingIndicator =
    isBusy && (!lastMessage || lastMessage.role !== 'assistant' || lastMessage.parts.length === 0);

  const sentInitialRef = useRef(false);
  useEffect(() => {
    if (initialMessage && !sentInitialRef.current && initialMessages.length === 0) {
      sentInitialRef.current = true;
      void chat.sendMessage({ text: initialMessage });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage]);

  // Auto-follow-scroll while streaming: keeps the view pinned to the
  // bottom as new tokens/parts stream in, not just once per whole message.
  // The previous version only re-ran this effect on messages.length /
  // showThinkingIndicator changes — both constant for the entire duration
  // of a single assistant reply streaming in, so mid-stream growth (the
  // actual "chat should auto scroll up as model [types]" case) never
  // re-triggered it; you only got a single scroll-to-bottom at the start
  // and end of a turn, not a smooth follow throughout. A MutationObserver
  // on the scroll container reacts to every DOM change the stream causes
  // (each token/part append), and only auto-follows when the user is
  // already near the bottom -- so it never yanks the view back down if
  // someone's deliberately scrolled up to reread earlier context.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    const scrollToBottom = () => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    // Always snap to bottom on a genuinely new turn starting.
    scrollToBottom();
    const observer = new MutationObserver(() => {
      if (isNearBottom()) scrollToBottom();
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [messages.length, showThinkingIndicator]);

  const onSend = (input: string, opts?: { attached?: AttachedContext[]; disabledTools?: string[]; model?: string }) => {
    // Switching to a different model mid-chat is handled by the parent
    // (chat-interface.tsx remounts into the right path); here we only ever
    // send under the current byokModelId/requestedModel.
    setTurnError(null);
    // Confirmed real bug (2026-07-11): the Tools menu's disabledTools was
    // collected here (opts.disabledTools) but never actually sent to the
    // server — every turn got every tool regardless of what was toggled
    // off in the UI. `sendMessage`'s second-arg `body` gets shallow-merged
    // on top of the transport's static body (byokModelId/requestedModel/
    // reasoningEffort), so this is additive, not a replacement.
    //
    // Retries the SEND itself (not the model's answer) up to twice with
    // backoff on a genuine network-level failure -- a `sendMessage` promise
    // only ever rejects when the request never made it to/from the server
    // at all (DNS hiccup, dropped Wi-Fi, a proxy timeout mid-handshake);
    // once the server actually receives it, failures come back as a
    // resolved stream with an error part instead, which `onError` above
    // already handles and this deliberately does NOT retry (retrying an
    // already-processed request risks the model seeing a duplicate turn).
    // "Every request should go through" (real ask, 2026-07-11) means this
    // one narrow, safe class of failure shouldn't just give up after one
    // flaky attempt.
    void sendWithRetry(() => chat.sendMessage({ text: input }, { body: { disabledTools: opts?.disabledTools ?? [] } })).catch(err => {
      console.error('[direct chat send failed]', err);
      setTurnError(readableChatErrorMessage(err));
    });
  };

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
      {pendingTurn && !turnError && (
        <div className="max-w-[832px] mx-auto w-full px-4">
          <div className="text-sm text-muted-foreground bg-muted/50 border border-border rounded-md px-3 py-2 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-pulse shrink-0" />
            Still working on this — it kept generating in the background while you were away. Catching up now…
          </div>
        </div>
      )}
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
