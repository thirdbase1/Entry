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
import { ChatInput, type ChatImageAttachment } from './chat-input';
import { AIReasoningCard } from './renderers/ai-reasoning-card';
import { VersionCard } from './renderers/version-card';
import { ChatPanelProvider, useChatPanel } from './chat-panel-context';
import type { AttachedContext } from './chat-context';
import { sendWithRetry, readableChatErrorMessage } from './send-with-retry';
import { AutoFixSendProvider } from './chat-auto-fix-context';
import { Tool, ToolHeader, ToolContent, ToolOutput, type ToolState } from '@/components/ui/tool';
import { ChooseResult } from './renderers/choose-result';
import { IntegrationConnectCard } from './renderers/integration-connect-card';
import { getKnownService } from '@/lib/integration-services';
import { claimIntegrationCallback, type IntegrationCallback } from './integration-callback-reader';

interface DirectChatInterfaceProps {
  sessionId?: string;
  /** Exactly one of these two is set. */
  byokModelId?: string;
  requestedModel?: string;
  model: string;
  setModel: (model: string) => void;
  placeholder?: string;
  placeholderTitle?: string;
  className?: string;
  headerContent?: React.ReactNode;
  initialMessage?: string;
  /** Mirrors ChatInterface's own prop — see chat-interface.tsx and
   *  integration-callback-reader.tsx. Wired through here too (2026-07-18)
   *  because this surface (BYOK/Gateway direct-chat) renders its OWN tool
   *  parts, separate from message-renderer.tsx's ToolPart switch. */
  integrationCallback?: IntegrationCallback;
}

/** Same heuristic as message-renderer.tsx's findChooseAnswer, adapted for plain AI SDK UIMessages. */
function findDirectChooseAnswer(messages: any[], afterIndex: number, options: string[]): string[] {
  for (let i = afterIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const text = (m.parts ?? [])
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('');
    const matched = options.filter(o => text.includes(o));
    if (matched.length) return text.split(', ');
  }
  return [];
}

/** Same shape as findDirectChooseAnswer above, for the connect card's
 *  own auto-sent "Connected X."/"skip" text -- see
 *  message-renderer.tsx's findConnectResolution (identical logic,
 *  duplicated here because this surface has its own separate tool
 *  rendering, not EveMessage-shaped `dynamic-tool` parts). */
function findDirectConnectResolution(messages: any[], afterIndex: number, serviceName: string): 'connected' | 'skipped' | undefined {
  for (let i = afterIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const text = (m.parts ?? [])
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('')
      .trim();
    if (text === `Connected ${serviceName}.`) return 'connected';
    if (text.toLowerCase() === 'skip') return 'skipped';
  }
  return undefined;
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
  placeholder = 'What are your thoughts?',
  placeholderTitle = 'What can I help you with?',
  className = '',
  headerContent,
  initialMessage,
  integrationCallback,
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
        body: byokModelId ? { byokModelId } : { requestedModel },
      }),
    [byokModelId, requestedModel]
  );

  // (2026-07-11) Removed the "Running: <model>" label per explicit user
  // request ("remove that stuff that show what model is running, I don't
  // like it") — was previously shown above the chat input and in the
  // header bar, sourced from byokModelId/requestedModel via useModelOptions.
  const chat = useChat({
    id: sessionId,
    messages: initialMessages,
    transport,
    // Throttle UI updates to at most once per 50ms (2026-07-18, "streaming
    // lags when the model is super fast" report) -- unset by default,
    // which means every single raw text-delta chunk from the stream
    // triggered its own synchronous React re-render of the whole message
    // list with NO ceiling on frequency. A fast model easily emits
    // 50-100+ chunks/sec, i.e. that many full re-renders/sec, which is
    // more work than the main thread can keep up with -- frames get
    // dropped, so the rendered text visibly falls behind what actually
    // arrived, and the autoscroll effect (which needs its own turn on
    // that same saturated main thread) falls behind too. 50ms (~20
    // renders/sec) is imperceptible as added latency but caps render
    // frequency far below what starves the browser, regardless of how
    // fast the model streams. See use-throttled-eve-agent.ts's file
    // comment for the equivalent fix on the other (default eve-agent)
    // chat path, which needed a custom wrapper since eve/react has no
    // built-in throttle option -- this path's AI SDK `useChat` already
    // ships one, it just wasn't turned on.
    throttle: 50,
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
      // The turn's version card (if any file changed) is appended
      // server-side slightly AFTER this stream finishes -- see
      // appendVersionCardMessage in packages/db/src/chat-versioning.ts,
      // called from an `after()` callback that by definition runs once
      // the whole HTTP response (the one onFinish just fired for) is
      // fully sent. So it can't be part of `finalMessages` yet; adopt it
      // with a few short, cheap retries instead of a hard reload -- same
      // "fetch the authoritative persisted snapshot" trick the dropped-
      // connection recovery effect above already uses, just proactive
      // instead of reactive. No-op (silently gives up) if it never shows
      // up -- the version itself is never lost either way, only this
      // immediate in-chat card would be delayed to next reload.
      const activeId = sessionId ?? chat.id;
      if (!activeId) return;
      for (const delayMs of [400, 900, 1600]) {
        await new Promise(r => setTimeout(r, delayMs));
        try {
          const res = await fetch(`/api/chats/${activeId}`);
          if (!res.ok) continue;
          const snap = await res.json();
          const persisted = Array.isArray(snap?.events) ? snap.events : null;
          if (persisted && persisted.length > chat.messages.length) {
            chat.setMessages(persisted);
            return;
          }
        } catch {
          // best-effort, try the next delay
        }
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
        // FOUND AND FIXED (2026-07-15, real bug hunt off actual production
        // logs -- confirmed via `vercel logs`: this endpoint was being
        // polled every 3s nonstop, and separately, the user's repeated
        // "agent stops instantly right after a tool call" report was
        // traced to THIS exact line, not the AI SDK/patch-package theory
        // from earlier). The old condition treated `chat.status ===
        // 'streaming'` (and 'submitted') as reasons to proceed into the
        // recovery fetch+overwrite below -- i.e. it ran this poll's
        // `chat.setMessages(persisted)` clobber path during a perfectly
        // healthy, actively-streaming turn, INCLUDING mid-tool-call, every
        // single 3s tick. A tool-call's result gets persisted server-side
        // the moment it completes, which routinely makes
        // `persisted.length >= chat.messages.length` true for an instant
        // right at that exact boundary -- a totally healthy turn, not a
        // dropped one. That was enough to trigger
        // `chat.setMessages(persisted)`, forcibly replacing the AI SDK
        // Chat instance's own live, actively-updating message array with a
        // static persisted snapshot mid-stream. Overwriting `messages` out
        // from under an in-flight stream reader like that desyncs the
        // hook's internal state from the actual network stream -- which is
        // exactly what "stops responding right after a tool call, no
        // error shown" looks like from the outside: not a crash, just this
        // component silently replacing the live turn with a frozen
        // snapshot the instant a tool call handed off to the next step.
        // Recovery should only ever act on a turn that's ACTUALLY stuck --
        // a real terminal 'error', or the reload-mid-turn case
        // (`looksIncomplete`) the 2026-07-11 fix above already covers --
        // never on 'streaming'/'submitted', which mean the live connection
        // itself already believes it's fine.
        if (chat.status === 'streaming' || chat.status === 'submitted') return;
        if (chat.status !== 'error' && !looksIncomplete) return;
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

  const { requestOpenHistory } = useChatPanel();

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

  // Mirrors chat-interface.tsx's own integrationCallback effect exactly
  // (2026-07-18) -- see that file's comment for the full flow. No
  // messages.length guard: this always fires into an existing
  // conversation (a reopen via OAuth redirect), never a brand-new chat.
  const sentIntegrationCallbackRef = useRef(false);
  useEffect(() => {
    if (!integrationCallback || sentIntegrationCallbackRef.current) return;
    sentIntegrationCallbackRef.current = true;
    // Tab-wide one-shot claim (2026-07-18 dupe-send fix) -- see
    // claimIntegrationCallback's own comment in integration-callback-reader.tsx
    // and chat-interface.tsx's identical effect for the full explanation.
    if (!claimIntegrationCallback(integrationCallback)) return;
    const name = getKnownService(integrationCallback.service)?.name ?? (integrationCallback.service.charAt(0).toUpperCase() + integrationCallback.service.slice(1));
    const text =
      integrationCallback.result === 'connected'
        ? `Connected ${name}.`
        : `${name} connection failed${integrationCallback.errorMessage ? `: ${integrationCallback.errorMessage}` : '.'}`;
    void sendWithRetry(() => chat.sendMessage({ text })).catch(err => {
      console.error('[integration callback send failed]', err);
    });
    if (sessionId) router.replace(`/chats/${sessionId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integrationCallback]);

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
  // FIXED (2026-07-17, "improve real time streaming" -- confirmed real
  // jank watching a fast-streaming reply): the MutationObserver callback
  // used to call `el.scrollTo({ behavior: 'smooth' })` directly, once per
  // DOM mutation. During active token/tool streaming that's dozens of
  // mutations per second, each one kicking off a brand-new ~300ms smooth-
  // scroll animation that immediately gets superseded (and visually
  // fights with) the next one a few ms later -- the browser never gets to
  // finish a single scroll animation, which reads as a stuttery, slightly
  // seasick jiggle right when the content is moving fastest. Two fixes,
  // applied together:
  //  1. Coalesce to at most one scroll per animation frame via
  //     requestAnimationFrame, instead of one call per raw mutation --
  //     the DOM can mutate many times within a single frame; only the
  //     last one before paint actually needs to move the scrollbar.
  //  2. Use instant ('auto') scrolling for those per-frame follow-ups,
  //     reserving the smooth animation for the one deliberate "snap to
  //     bottom" on a genuinely new turn starting. An instant scroll every
  //     frame tracks perfectly with fast-arriving content with zero
  //     animation-queue buildup; a smooth one only make sense as a single
  //     one-off jump, not as a per-frame follow.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    // Always snap to bottom (smoothly, once) on a genuinely new turn starting.
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    let rafId: number | null = null;
    const observer = new MutationObserver(() => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (isNearBottom()) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
      });
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [messages.length, showThinkingIndicator]);

  const onSend = (input: string, opts?: { attached?: AttachedContext[]; disabledTools?: string[]; model?: string; images?: ChatImageAttachment[] }) => {
    // Switching to a different model mid-chat is handled by the parent
    // (chat-interface.tsx remounts into the right path); here we only ever
    // send under the current byokModelId/requestedModel.
    setTurnError(null);
    // Confirmed real bug (2026-07-11): the Tools menu's disabledTools was
    // collected here (opts.disabledTools) but never actually sent to the
    // server — every turn got every tool regardless of what was toggled
    // off in the UI. `sendMessage`'s second-arg `body` gets shallow-merged
    // on top of the transport's static body (byokModelId/requestedModel),
    // so this is additive, not a replacement.
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
    // Images (2026-07-11, explicit user request -- "many models support
    // that", re: sending photos): each attached image is already a real
    // uploaded URL by the time onSend fires (ChatInput uploads on pick,
    // not on send), so it's just handed straight to sendMessage's native
    // `files` param as FileUIParts -- convertToModelMessages (route.ts)
    // turns these into real multimodal image content automatically, no
    // server-side change needed for that part.
    const files = (opts?.images ?? []).map(img => ({ type: 'file' as const, mediaType: img.mediaType, url: img.url, filename: img.filename }));
    void sendWithRetry(() => chat.sendMessage({ text: input, files: files.length > 0 ? files : undefined }, { body: { disabledTools: opts?.disabledTools ?? [] } })).catch(err => {
      console.error('[direct chat send failed]', err);
      setTurnError(readableChatErrorMessage(err));
    });
  };

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
    <ChatPanelProvider>
    <AutoFixSendProvider send={message => onSend(message)} isBusy={isBusy} hasMessages={messages.length > 0}>
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
                      if (part.type === 'data-version-card') {
                        return <VersionCard key={i} data={(part as any).data} onOpen={() => requestOpenHistory((part as any).data.versionNumber)} />;
                      }
                      // Renders an attached/generated image (2026-07-11,
                      // photo-attach feature). User-sent images are file
                      // parts with mediaType image/* -- the part.type
                      // itself is the AI SDK's generic 'file', not
                      // anything image-specific, so mediaType is the only
                      // real signal. Non-image files fall through to a
                      // plain download link so nothing silently vanishes.
                      if (part.type === 'file') {
                        const filePart = part as any;
                        if ((filePart.mediaType ?? '').startsWith('image/')) {
                          return (
                            // eslint-disable-next-line @next/next/no-img-element -- arbitrary uploaded/model blob URL
                            <img key={i} src={filePart.url} alt={filePart.filename ?? 'attached image'} className="max-w-full max-h-80 rounded-lg object-contain my-1" />
                          );
                        }
                        return (
                          <a key={i} href={filePart.url} target="_blank" rel="noopener noreferrer" className="text-primary underline text-sm block my-1">
                            {filePart.filename ?? 'Attached file'}
                          </a>
                        );
                      }
                      if (part.type === 'reasoning') {
                        const stillThinking = isLastAssistant && isBusy && i === m.parts.length - 1;
                        return <AIReasoningCard key={i} text={(part as any).text ?? ''} loading={stillThinking} />;
                      }
                      if (part.type.startsWith('tool-')) {
                        const state = ('state' in part ? (part as any).state : 'output-available') as ToolState;
                        const toolName = part.type.replace('tool-', '');
                        const input = 'input' in part ? (part as any).input : undefined;
                        const output = 'output' in part ? (part as any).output : undefined;
                        const errorText = state === 'output-error' ? ((part as any).errorText ?? 'Tool call failed.') : undefined;

                        // Fixed (2026-07-11): `choose` is always-on for this
                        // surface too (see route.ts), but until now it fell
                        // straight into the generic Tool card below — raw
                        // JSON dump, no way to actually pick an option. This
                        // path never had the eve chat's special case for it.
                        // Same interactive picker component, reused as-is —
                        // no separate/duplicate UI to keep in sync.
                        if (toolName === 'choose') {
                          const options = (output?.options ?? input?.options ?? []) as string[];
                          const answered = findDirectChooseAnswer(messages, mi, options);
                          return (
                            <ChooseResult
                              key={i}
                              part={part as any}
                              answered={answered.length ? answered : undefined}
                              onAnswer={onSend}
                            />
                          );
                        }

                        // Same needsConnect special-case as message-renderer.tsx
                        // (2026-07-18) -- this surface has its own separate tool
                        // rendering (not message-renderer.tsx's ToolPart switch),
                        // so it needs the exact same check duplicated here for
                        // BYOK/Gateway direct-chat to get the same connect card
                        // instead of a raw JSON tool-result dump.
                        if (state === 'output-available' && output && typeof output === 'object' && (output as any).needsConnect) {
                          const service = (output as any).service as string | undefined;
                          if (service) {
                            const name = getKnownService(service)?.name ?? (service.charAt(0).toUpperCase() + service.slice(1));
                            const initialResolved = findDirectConnectResolution(messages, mi, name);
                            return (
                              <IntegrationConnectCard
                                key={i}
                                service={service}
                                connectMode={((output as any).connectMode as 'oauth' | 'token') ?? 'token'}
                                toolCallId={`${mi}-${i}`}
                                onSend={onSend}
                                initialResolved={initialResolved}
                                reason={(output as any).reason as 'repo_not_installed' | undefined}
                              />
                            );
                          }
                        }

                        // Real AI SDK "Tool" component here too (2026-07-11,
                        // per explicit request) — this is the BYOK/Gateway
                        // direct-chat path's own tool-part rendering (a
                        // plain unboxed <div>, no collapsible, no status
                        // badge before), now sharing the exact same
                        // components/ui/tool.tsx primitives as the eve chat
                        // path's GenericToolResult/GenericToolCalling.
                        // Auto-open while actively running (2026-07-17,
                        // "improve real time streaming") -- Radix
                        // Collapsible's `defaultOpen` only applies at this
                        // element's own first render, which for a tool
                        // part is the moment its input starts arriving, so
                        // this reliably opens right as a call starts and
                        // simply stays however the user last left it once
                        // it completes -- no forced re-collapse fighting a
                        // manual expand/collapse click later.
                        return (
                          <Tool key={i} className="my-1" defaultOpen={state === 'input-streaming' || state === 'input-available'}>
                            <ToolHeader title={toolName} state={state} />
                            <ToolContent>
                              {errorText ? (
                                <ToolOutput errorText={errorText} />
                              ) : (
                                <ToolOutput
                                  output={
                                    output !== undefined ? (
                                      <pre className="whitespace-pre-wrap break-all font-mono p-2 rounded-md bg-muted/50 max-h-48 overflow-auto">
                                        {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
                                      </pre>
                                    ) : input !== undefined ? (
                                      <pre className="whitespace-pre-wrap break-all font-mono p-2 rounded-md bg-muted/50 max-h-48 overflow-auto">
                                        {JSON.stringify(input, null, 2)}
                                      </pre>
                                    ) : undefined
                                  }
                                />
                              )}
                            </ToolContent>
                          </Tool>
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
      {/* 2026-07-15: banner text removed per feedback -- pendingTurn itself
          (the actual "don't lose in-progress work" state) is untouched, this
          just no longer announces it with copy that read as unbacked fluff. */}
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
    </AutoFixSendProvider>
    </ChatPanelProvider>
  );
}
