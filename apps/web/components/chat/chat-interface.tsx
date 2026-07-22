'use client';

import { getKnownService } from '@/lib/integration-services';
import { useThrottledEveAgent } from './use-throttled-eve-agent';
import type { EveMessage, UseEveAgentSnapshot } from 'eve/react';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageRenderer } from './message-renderer';
import { ChatInput, type ChatImageAttachment } from './chat-input';
import { resolveContextForSend, type AttachedContext } from './chat-context';
import { buildConfigContext, DEFAULT_MODEL_ID, useModelOptions } from './chat-config';
import { DownArrow, type DownArrowRef } from './chat-arrow';
import { AggregatedTodoList } from './aggregated-todo-list';
import { DirectChatInterface } from './direct-chat-interface';
import { sendWithRetry, readableChatErrorMessage } from './send-with-retry';
import { reportClientError } from '@/lib/report-client-error';
import { AutoFixSendProvider } from './chat-auto-fix-context';
import { VersionCard, type VersionCardData } from './renderers/version-card';
import { ChatPanelProvider, useChatPanel } from './chat-panel-context';
import { toast } from '@/lib/toast';
import { useOnlineStatus } from './use-online-status';
import { useStreamingAutoScroll } from './use-streaming-autoscroll';
import { ThinkingIndicator } from './chat-thinking-indicator';
import { claimIntegrationCallback, type IntegrationCallback } from './integration-callback-reader';
import { silentlyUpdateChatUrl } from './silent-url-update';

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
  /** Preselect a model for a brand-new chat (e.g. ?model=byok:xyz after the
   *  cross-bucket redirect above) — takes priority over the last-used
   *  localStorage value, since the user just explicitly picked this one. */
  initialModel?: string;
  /** In-chat connect card (2026-07-18): set when this chat was just
   *  reopened via an OAuth connect redirect (github-oauth/callback or
   *  connect/start's returnTo) — triggers an automatic "Connected X."/
   *  error follow-up message so the agent resumes without the user
   *  retyping anything. See the effect below. */
  integrationCallback?: IntegrationCallback;
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
  initialModel,
  integrationCallback,
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

  // See use-online-status.ts's own comment for the full story: the
  // recovery effect below already repairs a turn silently dropped by a
  // network outage or a backgrounded/suspended tab, but until now nothing
  // ever told the user that was happening -- a real outage and a quiet
  // moment rendered identically. `isRecovering` flips true only while an
  // online/visibility-triggered recovery check is actually in flight (not
  // during the routine 3s background poll, which would otherwise make
  // this flicker on every single tick even when nothing is wrong), and is
  // what the banner below reads to show "Reconnecting…" instead of
  // nothing. `hasEverDroppedRef` gates the one-time success toast so it
  // only fires after a real recovery (found + adopted newer persisted
  // events), never on a routine no-op check.
  const isOnline = useOnlineStatus();
  const [isRecovering, setIsRecovering] = useState(false);
  const hasEverDroppedRef = useRef(false);
  // Live turn state, reported up from ChatInterfaceInner (which has the
  // only view of the actually-live agent.data.messages/agent.status) so
  // the recovery effect below can tell "genuinely stuck" apart from
  // "conversation just grew normally" -- see that effect's own comment
  // for the bug this fixes. A ref (not state) on purpose: this updates on
  // every message/status change during normal streaming, and re-running
  // the recovery effect (which adds/removes window listeners) on every
  // one of those would be wasteful for no benefit -- the effect only
  // needs the CURRENT value at the moment it actually checks, not to
  // re-subscribe every time it changes.
  const turnStateRef = useRef<{ isBusy: boolean; lastRole: string | undefined; messageCount: number }>({
    isBusy: false,
    lastRole: undefined,
    messageCount: 0,
  });
  const handleTurnStateChange = useCallback((s: { isBusy: boolean; lastRole: string | undefined; messageCount: number }) => {
    turnStateRef.current = s;
  }, []);

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
    if (initialModel) return initialModel;
    if (typeof window === 'undefined') return DEFAULT_MODEL_ID;
    try {
      return window.localStorage.getItem(LAST_MODEL_STORAGE_KEY) || DEFAULT_MODEL_ID;
    } catch {
      return DEFAULT_MODEL_ID;
    }
  });
  // Tracks whether the LIVE picker was actually touched by the user during
  // this component's lifetime, as opposed to just being seeded from a
  // resumed chat's stored model (see the seeding effect below, which now
  // deliberately bypasses this via setModelState directly). Needed so the
  // cross-bucket-redirect effect further down can't misfire during the
  // one-render gap between mount (model = DEFAULT_MODEL_ID) and that
  // seeding effect settling `model` to match `initial` — without this
  // guard, a freshly-opened BYOK/Gateway chat would see model=DEFAULT for
  // one render while initial.byokModelId is already set, look exactly
  // like a real cross-bucket pick, and wrongly redirect away immediately.
  const userChangedModelRef = useRef(false);
  const setModel = useCallback((next: string) => {
    userChangedModelRef.current = true;
    setModelState(next);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(LAST_MODEL_STORAGE_KEY, next);
    } catch {
      // localStorage can throw in private-browsing/quota-exceeded cases —
      // persistence is a nice-to-have, never worth crashing the chat over.
    }
  }, []);
  const modelInitializedRef = useRef(false);

  // FIXED (2026-07-21, real live incident: a brand-new chat "stops
  // instantly" with no visible response and never even creates a chat
  // row -- root-caused via direct DB inspection, since nothing was
  // throwing server-side at all to explain it). The `model` state above
  // seeds itself from localStorage's last-selected value with ZERO
  // validation -- if that was a `byok:<modelRowId>` pointing at a BYOK
  // provider model the user has since deleted (e.g. after rotating/
  // replacing their API keys, exactly as reported), a brand-new chat
  // sends that dead id straight to /api/direct/chat as byokModelId.
  // resolveByokModel throws "BYOK model not found, disabled, or not
  // owned by the current user" BEFORE preSave ever runs (that awaited
  // resolve happens earlier in the route than the chat-row create/
  // update), so the row is never created at all -- exactly matching
  // "the chat doesn't even exist" rather than "existed then got
  // deleted." Once the live BYOK catalog has actually loaded, silently
  // fall back to the default model instead of ever sending a
  // known-dead id. Only runs for a brand-new, not-yet-sent chat (never
  // yanks the model out from under an existing/in-flight thread), and
  // only once so it never fights a live user pick made afterward.
  const staleModelCheckedRef = useRef(false);
  const liveModelOptions = useModelOptions();
  useEffect(() => {
    if (sessionId) return; // only a brand-new chat can have a stale seed
    if (staleModelCheckedRef.current) return;
    if (userChangedModelRef.current) return; // user already picked live -- don't override
    if (!model.startsWith('byok:')) return;
    if (liveModelOptions.length === 0) return; // catalog hasn't loaded yet -- wait for it
    const stillValid = liveModelOptions.some(o => o.value === model);
    if (stillValid) {
      staleModelCheckedRef.current = true;
      return;
    }
    staleModelCheckedRef.current = true;
    console.warn('[chat] stale localStorage model no longer exists, falling back to default:', model);
    setModelState(DEFAULT_MODEL_ID);
    try {
      window.localStorage.removeItem(LAST_MODEL_STORAGE_KEY);
    } catch {
      // best-effort cleanup only
    }
  }, [sessionId, model, liveModelOptions]);


  // REMOVED (2026-07-15, user confirmed): there used to be a "self-heal"
  // guard here that force-reset `model` back to DEFAULT_MODEL_ID whenever
  // it didn't match an entry in the live `useModelOptions()` catalog,
  // built on a bad assumption that a bare value like literal "auto" was
  // always a stale/bogus leftover. It is not -- the user confirmed "auto"
  // is a real, working model on their own BYOK provider. The catalog can
  // legitimately lag or omit a model for reasons that have nothing to do
  // with validity (BYOK connection briefly disabled, fetch slower than
  // the first tool call, provider-side rename), and this guard already
  // caused one real regression on top of the misdiagnosis: clearing the
  // model flipped `liveIsDirect`, which the crossedBucket effect further
  // down reads as "user switched buckets," forcing a `router.push` to a
  // brand-new /chats page mid-conversation. Removed outright rather than
  // re-scoped again -- the backend (resolveByokModel /
  // apps/web/app/api/direct/chat/route.ts) already owns real invalid-model
  // handling; the frontend has no business silently second-guessing a
  // user's own model choice.

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

  // Reworked 2026-07-14: this used to poll every 3s FOREVER, unconditionally
  // comparing the persisted server event count against `initial.events` --
  // a snapshot frozen at mount and NEVER updated by normal live streaming
  // (only by this same recovery path). That meant persisted count grew
  // past it after literally every single completed turn, so every 3s tick
  // saw "persisted > current", showed "Back online — caught up" and force-
  // remounted the whole live session (bumping `recoveryKey`) -- with a
  // perfectly healthy connection. Confirmed as the real cause of two
  // reported bugs at once: the "reconnecting/back online" banner flapping
  // constantly, AND in-flight AI replies dying mid-stream, since the
  // remount tore down the live eve session out from under it every few
  // seconds. Fixed by only ever checking when the turn actually looks
  // stuck -- `turnStateRef` (see above) reports the LIVE current state, not
  // a stale mount-time snapshot: not busy, and the last message is still
  // the user's with no reply, which is exactly what "eve's own reconnect
  // exhausted its attempts and gave up silently" looks like (confirmed in
  // eve-agent-store.js: exhausted reconnects exit normally to status
  // 'ready', not 'error' -- status alone can't detect it). No more
  // permanent poll: eve/react's own client already auto-reconnects brief
  // blips on its own (up to `maxReconnectAttempts`, resuming from the last
  // event index -- see node_modules/eve/dist/src/client/open-stream.js);
  // this effect is only the fallback for outages long enough to exhaust
  // even that, and it now only ever acts when there's real evidence of it.
  useEffect(() => {
    const activeId = sessionId ?? liveSessionId;
    if (!activeId) return;
    const looksStuck = () => {
      const s = turnStateRef.current;
      return s.messageCount > 0 && !s.isBusy && s.lastRole === 'user';
    };
    const tryRecover = () => {
      if (!looksStuck()) return;
      void (async () => {
        setIsRecovering(true);
        try {
          const snap = await fetchSnapshot(activeId);
          const persistedEvents = Array.isArray(snap?.events) ? (snap!.events as unknown[]) : null;
          // FIXED (2026-07-15, explicit user report: "chat automatically
          // reloaded" with no real disconnect -- confirmed NOT a
          // navigation, a same-page remount): this used to compare against
          // `initial.events`, a snapshot fetched exactly ONCE at mount and
          // never touched again during a normal live conversation (the
          // only two writers of `initial` are that one mount-time fetch
          // and this very recovery branch). After even a single exchange,
          // the true persisted count on the server is always bigger than
          // that stale mount-time snapshot, so `persistedEvents.length >
          // currentEvents.length` was true almost every time this ran --
          // and `tryRecover` runs on every `visibilitychange`-to-visible,
          // an ordinary, frequent, totally benign event (alt-tab, clicking
          // another window, a notification shade opening on mobile). The
          // one thing actually gating a false trip was `looksStuck()`,
          // which reads true for a brief, completely normal instant on
          // EVERY turn (right after sending a message, before the
          // assistant's first token arrives) -- so switching tabs during
          // that ordinary latency window and back was enough to force a
          // full remount of the live session with zero real outage.
          // `turnStateRef.current.messageCount` is the live, currently-
          // rendered count (kept accurate in real time by
          // handleTurnStateChange), so comparing against that instead of
          // the frozen mount-time snapshot means this only ever trips when
          // the server genuinely has events the live view hasn't rendered
          // -- an actual dropped/stalled connection, not routine tab
          // switching.
          const currentCount = turnStateRef.current.messageCount;
          if (!persistedEvents) return;
          if (persistedEvents.length > currentCount) {
            setInitial(snap ?? {});
            setRecoveryKey(k => k + 1);
            hasEverDroppedRef.current = true;
            toast('Back online — caught up on what you missed');
            // Mirror onFinish's own first-turn navigation: if the client's
            // onFinish never got to run (the stream broke before it could
            // fire), the URL would otherwise be stuck on the "new chat"
            // route forever despite the chat now genuinely being persisted
            // under `activeId`.
            if (!createdRef.current) {
              createdRef.current = true;
              if (!sessionId) silentlyUpdateChatUrl(`/chats/${activeId}`);
            }
          }
        } finally {
          setIsRecovering(false);
        }
      })();
    };
    const onOnline = () => tryRecover();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tryRecover();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    // Also check once on mount -- covers a plain page reload landing
    // mid-turn (status resets to 'ready' on every fresh mount regardless
    // of whether the server is still generating, so `looksStuck()` above
    // is what actually detects that case here, not any online/visibility
    // event).
    //
    // WIDENED (2026-07-15, explicit "improve background work reliability"
    // request): this used to claim no interval was needed because
    // online/visibility events "already cover future" drops -- true only
    // for a tab that actually backgrounds or a connection that actually
    // flaps. It does NOT cover a tab that stays open and foregrounded the
    // whole time while the turn silently died server-side with no error
    // event ever reaching the client (a genuinely rare but real failure
    // mode -- e.g. the underlying provider connection died in a way eve's
    // own reconnect gave up on silently, see the `pendingTurn`/`isBusy`
    // comment above) -- in that shape NEITHER browser event ever fires, so
    // without a poll this chat would simply sit stuck forever until the
    // user happened to switch tabs or their network happened to blip.
    // direct-chat-interface.tsx's sibling recovery effect already runs an
    // always-on interval safely (tryRecover() is already a strict no-op
    // whenever `looksStuck()` is false, so polling costs nothing on a
    // healthy turn) -- mirroring that same proven-safe pattern here closes
    // this one remaining gap instead of only reacting to events that may
    // never come.
    tryRecover();
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
    // setModelState directly, NOT setModel — this is seeding the picker
    // to reflect a resumed chat's already-locked-in model, not a real
    // user preference change. Using setModel here used to also (a)
    // overwrite the user's "last used model" localStorage default just
    // from opening an old chat, and (b) as of this fix, would incorrectly
    // flip userChangedModelRef and defeat its entire purpose above.
    //
    // FIXED (2026-07-15, explicit user report: "model I choose doesn't
    // save even if I reload"): this only ever seeded from the chat's
    // SERVER-persisted byokModelId/requestedModel, which only gets written
    // once a turn actually completes on that chat. An existing-but-empty
    // chat (sessionId already assigned, e.g. right after creation, or one
    // where the user picked a model but hasn't sent a message with it
    // yet) has neither field set — and this component's very own model
    // initializer above (`useState`) deliberately returns DEFAULT_MODEL_ID
    // whenever `sessionId` is truthy, skipping localStorage entirely on
    // the assumption THIS effect would always settle the real value. For
    // that specific "existing chat, no model recorded yet" case it never
    // did, so the picker silently reset to Default on every reload
    // regardless of what was saved in localStorage. Now falls back to the
    // same last-used-model localStorage read the brand-new-chat path
    // already uses, instead of leaving it stuck on Default.
    if (initial.byokModelId) {
      setModelState(`byok:${initial.byokModelId}`);
    } else if (initial.requestedModel) {
      setModelState(`gateway:${initial.requestedModel}`);
    } else if (typeof window !== 'undefined') {
      try {
        const saved = window.localStorage.getItem(LAST_MODEL_STORAGE_KEY);
        if (saved) setModelState(saved);
      } catch {
        // localStorage can throw in private-browsing/quota-exceeded cases —
        // falling through to whatever `model` already is (DEFAULT_MODEL_ID)
        // is a fine degrade, never worth crashing the chat over.
      }
    }
  }, [initial]);

  // FIXED (2026-07-11): this used to lock a resumed chat's routing to
  // whatever `initial.byokModelId`/`initial.requestedModel` were at
  // creation time, full stop — the live `model` picker updated
  // localStorage and the UI's checkmark, but never actually changed what
  // got sent. Confirmed, reported bug: "switch model, doesn't change,
  // still uses the model I first used."
  //
  // What's actually locked, and can't be: which BUCKET a resumed row
  // belongs to — eve, or direct (BYOK/Gateway) — because eve rows and
  // direct rows persist completely different message shapes on
  // EveChatSession (HandleMessageStreamEvent[] vs plain UIMessage[], see
  // that model's schema comment). A resumed thread can't retroactively
  // become the other shape.
  //
  // What's NOT locked, and was wrongly being treated as if it were: WHICH
  // specific model within the direct bucket is used. BYOK<->BYOK,
  // BYOK<->Gateway, Gateway<->Gateway are all the exact same route
  // (/api/direct/chat) and the exact same message shape — nothing stops
  // that from tracking the live picker turn to turn, and now it does.
  //
  // HOTFIX (2026-07-11, later same day): all of this — including the
  // useEffect right below — MUST stay above the `if (!initial) return
  // <Loading/>` bailout a few lines down. It was originally added AFTER
  // that early return, which is a Rules-of-Hooks violation: during the
  // load flash `initial` is null and React never reaches this useEffect,
  // but the instant `initial` populates the very same render calls it —
  // the hook count differs between renders and React throws "Rendered
  // more hooks than during the previous render", crashing the whole
  // chat surface. That's the reported crash, and it hit EVERY chat (new
  // or existing) once `initial` finished loading, not just the
  // eve<->direct crossover case this effect is actually for. Guard
  // `rowIsDirect` on `!initial` (null while loading) rather than only on
  // `sessionId` so `crossedBucket` can't false-positive during that gap.
  const rowIsDirect = !initial ? null : sessionId ? !!(initial.byokModelId || initial.requestedModel) : null; // null = still loading, or brand-new (bucket not decided yet)
  // RETIRED (2026-07-21): eve is no longer the default path. Every NEW
  // chat now goes straight to /api/direct/chat regardless of which model
  // string is picked -- when it's neither `byok:` nor `gateway:` prefixed
  // (i.e. still DEFAULT_MODEL_ID / unset), byokModelId/requestedModel both
  // resolve to undefined below and the route itself resolves the same
  // catalog-picked default model eve's root agent used to
  // (resolveModelIdForProvider('anthropic'), see model-catalog.ts). Existing
  // rows already persisted in eve's own event shape (rowIsDirect computed
  // from their persisted byokModelId/requestedModel above) are unaffected --
  // they keep resuming via the eve-mounted renderer below exactly as
  // before; only NEW conversations skip eve entirely now.
  const liveIsDirect = true;
  const isDirect = rowIsDirect === null ? liveIsDirect : rowIsDirect;
  // Crossing eve<->direct on an EXISTING thread can't be hot-applied (see
  // above) — instead of silently ignoring the pick (the original bug,
  // just for the other combination), fork into a brand-new chat under
  // the newly-picked model and say so, rather than pretending nothing
  // happened.
  const crossedBucket = rowIsDirect !== null && rowIsDirect !== liveIsDirect;

  useEffect(() => {
    if (!initial) return; // still loading — nothing to cross yet
    if (!crossedBucket) return;
    if (!userChangedModelRef.current) return; // seeding-gap guard, see above
    toast(
      liveIsDirect
        ? "Switching models here starts a new chat — this thread can't change models."
        : "Switching to Default here starts a new chat — this thread can't change models."
    );
    const params = new URLSearchParams({ model });
    router.push(`/chats?${params.toString()}`);
  }, [initial, crossedBucket, liveIsDirect, model, router]);

  if (!initial) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Loading conversation…
      </div>
    );
  }

  if (isDirect) {
    // While `crossedBucket` (redirect in flight above), keep rendering
    // THIS row under its original, still-true bucket/model — never the
    // live pick that doesn't apply to it — so there's no flash of a
    // half-switched state before the redirect lands.
    const byokModelId = crossedBucket
      ? initial.byokModelId ?? undefined
      : model.startsWith('byok:')
        ? model.slice('byok:'.length)
        : undefined;
    const requestedModel = crossedBucket
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
        placeholder={placeholder}
        placeholderTitle={placeholderTitle}
        className={className}
        headerContent={headerContent}
        initialMessage={initialMessage}
        integrationCallback={integrationCallback}
      />
    );
  }

  return (
    <ChatPanelProvider>
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
      integrationCallback={integrationCallback}
      scrollRef={scrollRef}
      createdRef={createdRef}
      router={router}
      model={model}
      setModel={setModel}
      onSessionIdKnown={setLiveSessionId}
      isOnline={isOnline}
      isRecovering={isRecovering}
      onTurnStateChange={handleTurnStateChange}
    />
    </ChatPanelProvider>
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
  integrationCallback,
  scrollRef,
  createdRef,
  router,
  model,
  setModel,
  onSessionIdKnown,
  isOnline,
  isRecovering,
  onTurnStateChange,
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
  /** Lifted from the parent ChatInterface -- see its own `isOnline`/
   *  `isRecovering` comment for the full story. Passed down rather than
   *  duplicated here since the parent already owns the one recovery
   *  effect (keyed off `liveSessionId`/`sessionId`) that both components
   *  need to reflect. */
  isOnline: boolean;
  isRecovering: boolean;
  /** Reports the LIVE current turn state up to the parent's recovery
   *  effect on every change -- see that effect's own comment for why this
   *  replaced comparing against a stale mount-time snapshot. */
  onTurnStateChange: (state: { isBusy: boolean; lastRole: string | undefined; messageCount: number }) => void;
}) {
  // Turn-level failure banner. Without this, a turn that ends in
  // status "error" (e.g. run_model throwing because a BYOK provider
  // rejected the request, an invalid base URL, expired key, etc.)
  // renders literally NOTHING in the chat — no bubble, no error, just
  // silence. onError + the banner below are what was missing.
  const [turnError, setTurnError] = useState<string | null>(null);

  // Universal, tool-agnostic version cards for the eve-default path
  // (2026-07-16, real bug: "the versioning and the card none are
  // working or showing in the UI"). The server-side capture
  // (apps/agent/agent/hooks/version-capture.ts, a `turn.completed`
  // stream-event hook) already durably records every version the
  // instant a turn ends, regardless of which tool changed a file --
  // but it deliberately never touches THIS chat type's `events` log
  // (eve's own HandleMessageStreamEvent[] shape can't safely hold a
  // spliced-in card -- see chat-versioning.ts's appendVersionCardMessage
  // comment). So the card here is rendered PURELY client-side: the same
  // `turn.completed` event this component already receives live (see
  // `onEvent` below) triggers an immediate fetch of the read-only
  // versions-list route, and if it finds a version number newer than
  // the last one this component has seen, it renders a local card
  // anchored right after whatever the last message was at that moment
  // -- never persisted, just like AggregatedTodoList's own client-only
  // derived UI below.
  const [localVersionCards, setLocalVersionCards] = useState<Array<{ afterMessageId: string; data: VersionCardData }>>([]);
  const lastSeenVersionRef = useRef<number | null>(null);
  const latestMessagesRef = useRef<readonly EveMessage[]>([]);
  const { requestOpenHistory } = useChatPanel();

  const checkForNewVersion = useCallback(async (chatIdForVersions: string) => {
    try {
      const res = await fetch(`/api/chats/${chatIdForVersions}/versions`);
      if (!res.ok) return;
      const json = (await res.json()) as {
        versions: Array<{
          versionNumber: number;
          summary: string;
          filesChanged: number;
          linesAdded: number;
          linesRemoved: number;
          revertedFromVersionNumber: number | null;
          createdAt: string;
        }>;
      };
      const head = json.versions[0];
      if (!head) {
        if (lastSeenVersionRef.current === null) lastSeenVersionRef.current = 0;
        return;
      }
      if (lastSeenVersionRef.current === null) {
        // First check this mount -- seed silently. Only versions created
        // AFTER this chat was opened should ever pop up a fresh card.
        lastSeenVersionRef.current = head.versionNumber;
        return;
      }
      if (head.versionNumber <= lastSeenVersionRef.current) return;
      lastSeenVersionRef.current = head.versionNumber;
      const lastMessageId = latestMessagesRef.current[latestMessagesRef.current.length - 1]?.id;
      if (!lastMessageId) return;
      setLocalVersionCards(prev =>
        prev.some(c => c.data.versionNumber === head.versionNumber)
          ? prev
          : [
              ...prev,
              {
                afterMessageId: lastMessageId,
                data: {
                  versionNumber: head.versionNumber,
                  summary: head.summary,
                  filesChanged: head.filesChanged,
                  linesAdded: head.linesAdded,
                  linesRemoved: head.linesRemoved,
                  revertedFromVersionNumber: head.revertedFromVersionNumber,
                  createdAt: head.createdAt,
                },
              },
            ],
      );
    } catch {
      // Best-effort -- a missed check just means the card doesn't show
      // instantly here; the Versions tab (chat-versions-tab.tsx) always
      // reads the same durable rows directly and is never affected.
    }
  }, []);

  const chatIdRef = useRef<string | undefined>(sessionId);

  const agent = useThrottledEveAgent({
    // RETIRED (2026-07-22): host/auth used to conditionally point this at
    // a standalone Pxxl/Fly worker via NEXT_PUBLIC_EVE_AGENT_HOST -- that
    // worker is dead and the whole flag is permanently disabled now (see
    // eve-agent-host.ts). Always same-origin, in-process `withEve()`.
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
      reportClientError(readableChatErrorMessage(error), { region: 'eve-turn-error', stack: error instanceof Error ? error.stack : undefined });
      setTurnError(readableChatErrorMessage(error));
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
      if (event.type === 'turn.completed') {
        const activeId = chatIdRef.current;
        // Same not-created-yet guard as the mount effect above (2026-07-20
        // "404 on log" fix) -- on a brand-new chat's first turn, this event
        // fires before onFinish's /api/chats POST has created the row, so
        // the immediate check below would 404. Skip straight to the
        // 1200ms retry, which lands comfortably after that POST resolves.
        const chatRowExists = sessionId || createdRef.current;
        if (activeId && chatRowExists) void checkForNewVersion(activeId);
        if (activeId) {
          // Safety-net retry: the server-side git-diff capture hook
          // (apps/agent/agent/hooks/version-capture.ts) runs concurrently
          // with this same event reaching the client, so give it a beat
          // to land before giving up on the first check.
          setTimeout(() => void checkForNewVersion(activeId), 1200);
        }
        return;
      }
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
          silentlyUpdateChatUrl(`/chats/${sid}`);
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
    const activeId = agent.session?.sessionId ?? sessionId;
    chatIdRef.current = activeId;
    // BUG (2026-07-20, user-reported "404 on log" on every first prompt):
    // this used to fire as soon as eve confirmed a sessionId, which -- on
    // a brand-new chat -- is well BEFORE the /api/chats POST in onFinish
    // below ever creates that chat's row. GET .../versions 404s (by
    // design, see its own route file) whenever the chat row doesn't
    // exist yet, so every single new chat's first turn logged a 404 to
    // the console/network tab. `sessionId` (the route param) is only
    // ever present for a chat that's already persisted, so it's always
    // safe to check immediately; `createdRef.current` covers the
    // brand-new-chat case once its row genuinely exists.
    if (activeId && lastSeenVersionRef.current === null && (sessionId || createdRef.current)) void checkForNewVersion(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.session?.sessionId, sessionId]);

  const isBusy = agent.status === 'submitted' || agent.status === 'streaming';
  const messages = agent.data.messages;
  latestMessagesRef.current = messages;
  // Same reasoning as direct-chat-interface.tsx's `pendingTurn`: a fresh
  // mount (e.g. a reload while eve's session was still generating
  // server-side) always starts `agent.status` at 'ready' regardless of
  // whether a turn is actually still in flight -- the store's constructor
  // hardcodes this (confirmed directly in eve-agent-store.js), it never
  // auto-reconnects to a live stream just from being handed a resumable
  // `initialSession` cursor. The last event being the user's own message
  // with no assistant reply after it is what that situation looks like
  // from a fresh mount, independent of `agent.status`.
  const pendingTurn = !isBusy && messages.length > 0 && messages[messages.length - 1]?.role === 'user';
  // "Thinking…" latency placeholder (2026-07-17, parity with
  // direct-chat-interface.tsx's own showThinkingIndicator) -- visible
  // from send until the assistant reply actually has something to show
  // (text, a tool call, or reasoning), then gets out of the way the
  // instant real content starts arriving.
  const lastMessageForThinking = messages[messages.length - 1];
  const showThinkingIndicator =
    isBusy && (!lastMessageForThinking || lastMessageForThinking.role !== 'assistant' || lastMessageForThinking.parts.length === 0);

  // Report live turn state up to the parent's recovery effect -- see its
  // own comment for why this replaced a stale mount-time snapshot
  // comparison. Deliberately keyed on isBusy/length/role only (not message
  // content), so this doesn't fire on every streamed token, only on the
  // transitions that actually matter for "does this look stuck".
  const lastRole = messages[messages.length - 1]?.role;
  useEffect(() => {
    onTurnStateChange({ isBusy, lastRole, messageCount: messages.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBusy, messages.length, lastRole]);
  // Covers the other silent-drop shape `pendingTurn` above can't: a reply
  // that had already started streaming before the connection broke (last
  // message is already an assistant one, so `pendingTurn`'s user-message
  // check never fires) mid-recovery. `isRecovering` (see its own comment
  // above) is what actually flips this on -- only for the two explicit
  // "you just came back" triggers, never the silent 3s background poll.
  const downArrowRef = useRef<DownArrowRef>(null);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [scrollRef]);

  // Real-time, image-load-aware auto-follow (2026-07-17) -- see
  // use-streaming-autoscroll.ts's file comment. Continuously tracks the
  // bottom as THIS message's own content streams in (not just once per
  // whole new message), and only while already near the bottom.
  useStreamingAutoScroll(scrollRef, messages.length);

  // Down-arrow visibility on new messages (separate from the above --
  // this is purely the "should the manual scroll-to-bottom button be
  // showing" signal, unrelated to whether auto-follow itself is active).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isAtBottom) {
      downArrowRef.current?.hide();
    } else {
      downArrowRef.current?.show();
    }
  }, [messages.length]);

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

  // 2026-07-18: in-chat connect card follow-through. When this chat was
  // just reopened via an OAuth redirect (github-oauth/callback or
  // connect/start's returnTo — see integration-callback-reader.tsx),
  // automatically send "Connected <service>." (or an error message) as
  // a real user turn, WITHOUT the `messages.length === 0` guard the
  // initialMessage effect above has (this always fires into an existing
  // conversation, never a brand-new one). The agent's persona
  // instructions tell it to treat that exact text as "retry the action
  // that needed this credential." Strips the query params afterward so
  // a refresh/back-nav doesn't resend it.
  const sentIntegrationCallbackRef = useRef(false);
  useEffect(() => {
    if (!integrationCallback || sentIntegrationCallbackRef.current) return;
    sentIntegrationCallbackRef.current = true;
    // Tab-wide one-shot claim (2026-07-18 dupe-send fix) -- see
    // claimIntegrationCallback's own comment. Necessary IN ADDITION to
    // the ref above, not instead of it: the ref only protects against
    // THIS component instance re-running; the claim protects against a
    // DIFFERENT component instance (DirectChatInterface's own copy of
    // this same effect) independently processing the same callback.
    if (!claimIntegrationCallback(integrationCallback)) return;
    const name = getKnownService(integrationCallback.service)?.name ?? (integrationCallback.service.charAt(0).toUpperCase() + integrationCallback.service.slice(1));
    const text =
      integrationCallback.result === 'connected'
        ? `Connected ${name}.`
        : `${name} connection failed${integrationCallback.errorMessage ? `: ${integrationCallback.errorMessage}` : '.'}`;
    void sendWithRetry(() => agent.send({ message: text })).catch(err => {
      console.error('[integration callback send failed]', err);
    });
    if (sessionId) router.replace(`/chats/${sessionId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [integrationCallback]);

  const onSend = useCallback(
    (input: string, opts?: { attached?: AttachedContext[]; disabledTools?: string[]; model?: string; images?: ChatImageAttachment[] }) => {
      setTurnError(null);
      void (async () => {
        const [attachedContext, configHint] = await Promise.all([
          resolveContextForSend(opts?.attached ?? []),
          Promise.resolve(buildConfigContext(opts?.model ?? '', opts?.disabledTools ?? [])),
        ]);
        const clientContext = [attachedContext, configHint].filter(Boolean).join('\n\n') || undefined;
        // Images (2026-07-11, photo-attach feature): eve's `send` accepts
        // `message` as a plain string OR the AI SDK's UserContent array
        // (text/image/file parts) -- when there are images, switch to the
        // array form so the model actually receives them as real image
        // content, not just a link in the text. NOTE: eve's own
        // EveMessagePart projection (message-reducer-types) has no
        // image/file variant yet, so the sent photo won't render a
        // thumbnail back in this surface's own history the way the
        // BYOK/Gateway direct-chat path now does -- it still reaches and
        // is seen by the model, just without a client-side preview here.
        const message =
          opts?.images && opts.images.length > 0
            ? [{ type: 'text' as const, text: input }, ...opts.images.map(img => ({ type: 'image' as const, image: img.url, mediaType: img.mediaType }))]
            : input;
        // Retries a genuine network-level send failure up to twice with
        // backoff -- see send-with-retry.ts's file comment for exactly
        // which failures qualify and why only those. agent.send rejecting
        // for any OTHER reason (a turn already in flight, or a real
        // pre-flight API failure) is left alone: onError above already
        // covers mid-stream failures, this only closes the "message never
        // even reached the server" gap.
        await sendWithRetry(() => agent.send({ message, clientContext })).catch(err => {
          console.error('[send failed]', err);
          reportClientError(readableChatErrorMessage(err), { region: 'eve-send-failed', stack: err instanceof Error ? err.stack : undefined });
          setTurnError(readableChatErrorMessage(err));
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
    <AutoFixSendProvider send={message => onSend(message)} isBusy={isBusy} hasMessages={messages.length > 0}>
      <div className={`flex flex-col h-full ${className}`}>
        {headerContent}
        <div className="flex-1 h-0 flex flex-col relative">
          <div ref={scrollRef} className="flex-1 overflow-y-auto py-4">
            <div className="max-w-[832px] mx-auto px-4 w-full flex flex-col [&>*:not(:first-child)]:mt-4">
              {messages.map((m, idx) => (
                <Fragment key={m.id}>
                  <MessageRenderer
                    message={m}
                    isStreaming={isBusy && idx === messages.length - 1}
                    allMessages={messages}
                    onSend={onSend}
                  />
                  {localVersionCards
                    .filter(c => c.afterMessageId === m.id)
                    .map(c => (
                      <VersionCard key={`version-${c.data.versionNumber}`} data={c.data} onOpen={() => requestOpenHistory(c.data.versionNumber)} />
                    ))}
                </Fragment>
              ))}
              {showThinkingIndicator && (
                <div className="flex justify-start">
                  <ThinkingIndicator />
                </div>
              )}
            </div>
          </div>
          <DownArrow
            ref={downArrowRef}
            onClick={scrollToBottom}
            loading={isBusy}
          />
        </div>
        <AggregatedTodoList messages={messages} />
        {!isOnline && (
          <div className="max-w-[832px] mx-auto w-full px-4">
            <div className="text-sm text-muted-foreground bg-muted/50 border border-border rounded-md px-3 py-2 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
              You&apos;re offline — I&apos;ll reconnect and catch up automatically once you&apos;re back.
            </div>
          </div>
        )}
        {/* 2026-07-15: dropped the "Still working on this..." pendingTurn
            banner text per explicit feedback (felt like unbacked fluff) --
            the actual pendingTurn/isRecovering state machine underneath is
            UNCHANGED, so a turn that kept generating while the user was
            away still resumes and nothing is ever lost; only the "Reconnecting…"
            transport-level banner remains, since that one reflects a real,
            momentary state (socket re-establishing) worth surfacing. */}
        {isOnline && isRecovering && !pendingTurn && !turnError && (
          <div className="max-w-[832px] mx-auto w-full px-4">
            <div className="text-sm text-muted-foreground bg-muted/50 border border-border rounded-md px-3 py-2 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-pulse shrink-0" />
              Reconnecting…
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
        <div className="sticky bottom-0 z-10 w-full bg-background max-w-[832px] px-4 mx-auto py-4">
          <ChatInput onSend={onSend} sending={isBusy} streaming={agent.status === 'streaming'} onAbort={agent.stop} placeholder={placeholder} initialAttached={initialAttachedContext} model={model} onModelChange={setModel} />
        </div>
      </div>
    </AutoFixSendProvider>
  );
}
