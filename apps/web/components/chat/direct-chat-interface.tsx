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
import { type UIMessage } from 'ai';
import { WorkflowChatTransport } from '@ai-sdk/workflow';
import { fetchWithIdleTimeout } from '@/lib/chat/fetch-with-idle-timeout';
import { CLIENT_IDLE_TIMEOUT_MS } from '@/lib/direct-chat/timing';
import { Suspense, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MarkdownText } from '@/components/ui/markdown';
import { CollapsibleUserText } from './collapsible-user-text';
import { useStreamingAutoScroll } from './use-streaming-autoscroll';
import { ChatInput, type ChatImageAttachment } from './chat-input';
import { AIReasoningCard } from './renderers/ai-reasoning-card';
import { VersionCard } from './renderers/version-card';
import { ChatPanelProvider, useChatPanel } from './chat-panel-context';
import type { AttachedContext } from './chat-context';
import { sendWithRetry, readableChatErrorMessage } from './send-with-retry';
import { reportClientError } from '@/lib/report-client-error';
import { AutoFixSendProvider } from './chat-auto-fix-context';
import { AutoCollapseTool, ToolHeader, ToolContent, ToolOutput, type ToolState } from '@/components/ui/tool';
import { ChooseResult } from './renderers/choose-result';
import { IntegrationConnectCard } from './renderers/integration-connect-card';
import { getKnownService } from '@/lib/integration-services';

/**
 * FIXED (2026-07-24, real user-reported bug: "I send a message and it
 * disappears instantly, only shows back once the agent is done with the
 * turn -- happens many times"). Both places in this file that adopt a
 * DB-fetched snapshot over the live `chat.messages` (this recovery poll,
 * and onFinish's version-card catch-up loop) already guarded against
 * REGRESSING to a strictly shorter array -- but a same-length or
 * differently-shaped `persisted` snapshot (e.g. the DB row observed in a
 * split second between the user's own optimistic send landing locally and
 * the server's own persistence of that same turn actually committing --
 * a real, confirmed-possible race, not hypothetical: `preSave` and this
 * poll are two entirely independent round-trips with no ordering
 * guarantee between them) could still get adopted even if it silently
 * drops the very message currently on screen, if its id/shape doesn't
 * line up 1:1 with the live array for any reason. That's exactly what
 * "disappears, only comes back once the turn ends" looks like: the poll
 * clobbers the live optimistic array with a leaner/older persisted one,
 * and it only self-corrects once the FINAL onFinish save re-adopts the
 * complete result. This is a hard invariant, not a heuristic: never
 * adopt a fetched snapshot unless every message id currently visible is
 * still present in it. A snapshot can add messages/parts freely; it can
 * never make something already on screen vanish.
 */
/** Total text length across a message's parts -- the cheap proxy this file
 *  already uses elsewhere (see lastProgressRef's stall-detection
 *  signature) for "how much of this message has actually streamed in." */
function messageTextLength(m: UIMessage): number {
  return (m.parts ?? []).reduce((sum: number, p: any) => sum + (typeof p?.text === 'string' ? p.text.length : 0), 0);
}

function mergeMessagesAppendOnly(current: UIMessage[], persisted: UIMessage[]): UIMessage[] {
  const persistedById = new Map(persisted.map(message => [message.id, message]));
  const merged = current.map(message => {
    const incoming = persistedById.get(message.id);
    if (!incoming) return message;
    // A database snapshot may lag the live stream. Keep the richer version
    // already on screen; only adopt a snapshot that is at least as complete.
    return isMessageAtLeastAsComplete(incoming, message) ? incoming : message;
  });
  const currentIds = new Set(current.map(message => message.id));
  for (const message of persisted) {
    if (!currentIds.has(message.id)) merged.push(message);
  }
  return merged;
}

function isMessageAtLeastAsComplete(incoming: UIMessage, current: UIMessage): boolean {
  const incomingText = messageTextLength(incoming);
  const currentText = messageTextLength(current);
  if (incomingText !== currentText) return incomingText > currentText;
  const incomingParts = incoming.parts?.length ?? 0;
  const currentParts = current.parts?.length ?? 0;
  if (incomingParts !== currentParts) return incomingParts > currentParts;
  return JSON.stringify(incoming).length >= JSON.stringify(current).length;
}

function isSafeToAdopt(persisted: UIMessage[], current: UIMessage[]): boolean {
  if (persisted.length < current.length) return false;
  const persistedById = new Map(persisted.map(m => [m.id, m]));
  return current.every(m => {
    const match = persistedById.get(m.id);
    if (!match) return false;
    // FIXED (2026-07-25, real user report: "message still disappear
    // sometimes and only show when model turn is complete"). The id-only
    // check above already guaranteed a message can't vanish outright, but
    // said nothing about its CONTENT -- a message id being present with
    // fewer/shorter parts than what's already rendered is just as visible
    // a regression as the message disappearing entirely (the streamed-in
    // text on screen visibly shrinks or blanks), and it's exactly what
    // happens when this poll's DB fetch lands in the ~3s window between
    // incremental saves: the client has already streamed further ahead
    // than the DB has been allowed to persist yet. Refuse to adopt a
    // snapshot that would shrink any message currently on screen -- a
    // real snapshot can only ever add to a message (more parts arriving,
    // more text streamed in since the last save), never take away.
    return messageTextLength(match) >= messageTextLength(m) && (match.parts?.length ?? 0) >= (m.parts?.length ?? 0);
  });
}

// CONSOLIDATED (2026-07-26, "proper rework" pass on the reconnect system):
// `pendingTurn` and `turnError` used to be two independent `useState`
// calls, each with its OWN staleness-mirror ref (previously
// `pendingTurnRef`/`turnErrorRef`) purely to solve the same problem
// twice -- the recovery effect's closures below only get recreated on
// [sessionId, chat.id, chat.status], so reading the plain state
// variables inside an old closure could see an already-stale value.
// Tracing every bug fixed in this file across the whole reconnect saga
// (2026-07-11 through 2026-07-26) turned up the same root shape every
// time: one of these loosely-coordinated flags not getting updated (or
// read) in one specific branch. A single reducer with named actions
// makes every valid transition visible in ONE place instead of scattered
// ad-hoc `setPendingTurn()`/`setTurnError()` calls spread across 1000+
// lines -- and one mirror ref replaces two.
// `lastResumeAttemptMs` is a mutable throttle bookkeeping field bolted
// onto the ref's *current* object directly (not through the reducer --
// it's not user-visible state, just an internal timestamp guarding
// resume-attempt spam), so it's declared as optional here instead of a
// reducer action. FIXED (2026-07-27, PR review): this field was being
// read/written both with and without `as any` casts inconsistently,
// which only happened to typecheck at the call sites that used the
// cast -- declaring it for real here makes every access, cast or not,
// type-check correctly.
type TurnLifecycleState = { pendingTurn: boolean; turnError: string | null; isReconnecting: boolean; lastResumeAttemptMs?: number };
type TurnLifecycleAction =
  | { type: 'SET_PENDING'; value: boolean }
  | { type: 'SET_ERROR'; message: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SET_RECONNECTING'; value: boolean }
  // A reconnect poll found genuinely newer content: adopt both the busy
  // state (still active or not) and clear any stale error atomically --
  // splitting this into two dispatches would let a render land in
  // between with one updated and the other not.
  | { type: 'RECONNECT_PROGRESS'; stillActive: boolean }
  // The recovery poll gave up for good (see its own comment: 8
  // consecutive real 404s -- a chat that will never resolve). Always
  // clears the busy lock; only overwrites the error message when one is
  // actually provided (a silent give-up with content already showing
  // shouldn't retroactively invent an error).
  | { type: 'RECONNECT_GAVE_UP'; message?: string };

function turnLifecycleReducer(state: TurnLifecycleState, action: TurnLifecycleAction): TurnLifecycleState {
  switch (action.type) {
    case 'SET_PENDING':
      return state.pendingTurn === action.value ? state : { ...state, pendingTurn: action.value };
    case 'SET_ERROR':
      // CLEAR pendingTurn here (2026-07-27): SET_ERROR is now ONLY called
      // from onSend's .catch handler (sendWithRetry failed completely),
      // NOT from onError (which uses SET_RECONNECTING instead). When the
      // SEND itself fails, there's no background turn running — the
      // request never reached the server — so clearing pendingTurn is
      // correct and unblocks the user to retry. The stream-drop case
      // (server still running) uses SET_RECONNECTING which keeps
      // pendingTurn true.
      return { ...state, turnError: action.message, pendingTurn: false, isReconnecting: false };
    case 'SET_RECONNECTING':
      // When reconnecting, keep pendingTurn true so the send button stays
      // busy (not white/idle) — the model IS still working, we're just
      // reattaching.
      if (action.value === state.isReconnecting) return state;
      return { ...state, isReconnecting: action.value, pendingTurn: action.value ? true : state.pendingTurn };
    case 'CLEAR_ERROR':
      if (state.turnError === null && !state.isReconnecting) return state;
      return { ...state, turnError: null, isReconnecting: false };
    case 'RECONNECT_PROGRESS':
      return { pendingTurn: action.stillActive, turnError: null, isReconnecting: false };
    case 'RECONNECT_GAVE_UP':
      return { pendingTurn: false, turnError: action.message ?? state.turnError, isReconnecting: false };
    default:
      return state;
  }
}

import { claimIntegrationCallback, type IntegrationCallback } from './integration-callback-reader';
import { useLiveTurnElapsedMs, TurnDurationLabel, LiveTurnDurationLabel } from './turn-timer';
import { silentlyUpdateChatUrl } from './silent-url-update';
import { ChatPageHeader } from './chat-page-header';
import { toast } from '@/lib/toast';
import { useLibraryStore } from '@/store/library';

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
  initialMessage?: string;
  /** Mirrors ChatInterface's own prop — see chat-interface.tsx and
   *  integration-callback-reader.tsx. Wired through here too (2026-07-18)
   *  because this surface (BYOK/Gateway direct-chat) renders its OWN tool
   *  parts, separate from message-renderer.tsx's ToolPart switch. */
  integrationCallback?: IntegrationCallback;
  /** Server-confirmed live turn state; prevents reconnecting ordinary history opens. */
  initialTurnActive?: boolean;
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

function ThinkingIndicator({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground py-1">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.2s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.1s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" />
      {label && <span className="ml-1 text-xs">{label}</span>}
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
  // Server-issued last-write time for this chat row (EveChatSession.updatedAt).
  // Used ONLY as the staleness bound on the interrupted-turn seed below --
  // the persisted `events` array holds AI SDK UIMessages, which carry no
  // per-message timestamp of their own, so the row's own updatedAt is the
  // only trustworthy "when did the server last touch this turn" signal
  // available on load.
  useEffect(() => {
    if (!sessionId) return;
    setInitialMessages(null);
    let cancelled = false;
    fetch(`/api/chats/${sessionId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(snap => {
        if (cancelled) return;
        setInitialMessages(Array.isArray(snap?.events) ? snap.events : []);
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
  return (
    <DirectChatSession
      key={sessionId ?? 'new'}
      {...props}
      initialMessages={initialMessages}
    />
  );
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
  initialMessage,
  integrationCallback,
  initialTurnActive = false,
  initialMessages,
}: DirectChatInterfaceProps & { initialMessages: any[] }) {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const createdRef = useRef(!!sessionId);
  // Give-up counters for the 3s recovery poll below (2026-07-21 fix --
  // see the poll's own comment for why this exists).
  const missedPollsRef = useRef(0);
  // FIXED (2026-08-05, real bug reproduced from a screen recording: chat
  // UI permanently freezes ~2min into a long background tool call --
  // no error, no reconnecting indicator, just stuck -- while the server
  // keeps working and finishes minutes later, only visible again after a
  // full page reload). Root cause: missedPollsRef above used to count
  // ANY non-OK `/api/chats/{id}` response toward the 8-strikes give-up
  // below, but that give-up is only actually correct for a genuine 404
  // (per its own original comment: "a chat id that will NEVER resolve").
  // A transient 5xx/502/503 from the exact same proxy hop that's already
  // known to drop long-lived connections (see timing.ts/turn-lock.ts's
  // own comments on this) would ALSO occasionally hit this snapshot GET
  // -- and during the fast 800ms poll cadence (which is exactly when a
  // long background turn is being watched most closely) 8 consecutive
  // hits is only ~6.4s of bad luck, not the ~24s of real grace the give-
  // up was designed around. Once tripped, `gaveUpRef` permanently stops
  // ALL future polling for this chat (see scheduleNext below) and
  // RECONNECT_GAVE_UP clears pendingTurn -- exactly the silent freeze
  // symptom. Now: only a REAL 404 counts toward give-up at all (tracked
  // by wall-clock time below, not raw poll count, so it's immune to the
  // 800ms/3000ms adaptive-cadence swing); any other non-OK status is
  // treated exactly like a network hiccup -- logged, never counted,
  // retried indefinitely on the next tick, same as the catch-block below
  // already does for a thrown fetch rejection.
  const firstNotFoundAtRef = useRef<number | null>(null);
  const gaveUpRef = useRef(false);
  // FIXED (2026-07-24, real user report: "if I reload the page while the
  // model is working, does the send button still turn black?" -- it
  // didn't. `chat.status` is a brand-new AI SDK hook's own in-memory
  // state -- it always (re-)initializes to 'ready' on every fresh mount,
  // with zero awareness of whether the server is still actually running
  // this turn (which, per the durability model above, it very well can
  // be -- reload/close-tab/lose-network mid-turn never stops the server
  // side work). So a reload landing mid-turn showed the button/input as
  // fully idle -- exactly backwards, since that's precisely the moment
  // real background work is still happening. `pendingTurn` is a second,
  // independent busy signal fed by the SAME recovery poll below (not
  // `chat.status`, which this poll deliberately doesn't drive): every
  // tick that finds genuinely NEW content in the DB (`persistedIsNewer`)
  // means the server just produced more since last check -- still
  // working, so this flips true. Initial value covers the most common
  // case instantly (no waiting on the first poll tick at all): a reload
  // landing with the last message still from 'user' -- i.e. sent, no
  // reply persisted yet -- is unambiguous proof a turn was in flight the
  // moment the page was left.
  // Wall-clock, not a fixed poll-tick count: the server's own
  // incremental save is throttled to at most once per 3s (see route.ts's
  // INCREMENTAL_SAVE_MIN_INTERVAL_MS) -- a perfectly healthy, still-
  // running turn can legitimately show zero DB growth for a few seconds
  // at a time between saves. A tick-count threshold would have to know
  // the current poll cadence (800ms fast vs 3s normal) to stay correct;
  // wall-clock time doesn't care, so it can't declare "settled" while
  // still inside a normal save gap no matter which cadence is active.
  // Upper bound on how old an interrupted-looking turn can be before the
  // "server might still be working on it" seed below stops believing it.
  // Anchored to the agent runtime's own hard ceiling -- with-agent-timeout.ts
  // caps any single tool call at MAX_TIMEOUT_SECONDS (1 hour), so a turn
  // whose last persisted message is older than that provably cannot still
  // be running. Doubled to 2h purely as slack for clock skew between the
  // user's device and the server (this compares a server-issued updatedAt
  // against a client-side Date.now()); the exact value is not load-bearing,
  // only the existence of SOME finite bound is.
  const SETTLE_QUIET_MS = 4_500;
  const lastGrowthAtRef = useRef(Date.now());
  // STALENESS BOUND (2026-07-28, owner bug report: thinking indicator
  // spinning on both a NEW chat and an OLD chat without sending anything).
  // The seed above is a heuristic -- "last persisted message is from the
  // user" is treated as proof a turn was in flight when the page was left.
  // That inference is only sound while the turn could PLAUSIBLY still be
  // running. It is not time-bounded, so it also fires for a conversation
  // whose final turn died months ago (server crash / abort / error before
  // any assistant row was persisted). Opening that old chat re-seeded
  // pendingTurn=true forever: the recovery poll only clears pendingTurn on
  // RECONNECT_PROGRESS/RECONNECT_GAVE_UP, and a long-dead turn produces no
  // new DB content to trigger either -- so the spinner never settles and
  // the composer stays locked (isBusy) on a chat the user never touched.
  //
  // A turn that was genuinely interrupted seconds ago is worth recovering.
  // One whose last message is older than the server could still be working
  // on is not. MAX_RESUMABLE_AGE_MS bounds the heuristic to the server's
  // own hard turn ceiling, so we never claim "still running" for something
  // that provably cannot be.
  const [turnLifecycle, dispatchTurn] = useReducer(turnLifecycleReducer, undefined, () => {
    const last = initialMessages[initialMessages.length - 1];
    // Empty history (a brand-new chat) is already excluded by length > 0.
    const looksInterrupted = initialMessages.length > 0 && (!last || last.role === 'user');
    if (!looksInterrupted) return { pendingTurn: false, turnError: null, isReconnecting: false };
    // Staleness bound uses the chat ROW's server-issued updatedAt, not a
    // per-message timestamp: `events` holds AI SDK UIMessages, which have
    // no createdAt of their own, so there is nothing message-level to read.
    // updatedAt is bumped by the very same write that persisted this
    // trailing user message, so it IS that turn's start time in practice.
    // Missing/unparseable timestamp => treat as NOT resumable: failing
    // closed costs at most a slightly late spinner on a genuine resume
    // (the recovery poll flips pendingTurn true within one 800ms tick as
    // soon as it sees new content), whereas failing open is exactly the
    // permanently-stuck-chat bug being fixed here.
    const pendingTurn = initialTurnActive;
    return { pendingTurn, turnError: null, isReconnecting: false };
  });
  const { pendingTurn, turnError, isReconnecting } = turnLifecycle;
  const pollIdRef = useRef<number | undefined>(undefined);
  // Always-fresh mirror for the recovery-poll effect below, whose
  // `tryRecover` closures only get recreated when [sessionId, chat.id,
  // chat.status] change -- reading `turnLifecycle` directly inside an old
  // closure could see an already-stale value otherwise.
  const turnLifecycleRef = useRef(turnLifecycle);
  // RE-ENTRANCY GUARD for onError: resumeStream() called inside onError's
  // retry loop can itself trigger onError again (the AI SDK calls onError
  // when the reattached stream errors). Without this guard, each retry
  // creates a NEW retry loop, overlapping with the first — up to 4 nested
  // loops, each making 4 attempts = 16 concurrent resumeStream() calls.
  const resumingRef = useRef(false);
  // Track when resumeStream was last attempted to avoid a failure cycle
  // (see recovery poll's 30s cooldown comment).
  if (!('lastResumeAttemptMs' in turnLifecycleRef.current)) {
    turnLifecycleRef.current.lastResumeAttemptMs = 0;
  }
  useEffect(() => {
    turnLifecycleRef.current = turnLifecycle;
  }, [turnLifecycle]);
  // STALL DETECTION (2026-07-23, explicit user report: "anytime my screen
  // turn off the agent stop instantly... never stop even if it lose
  // internet connection"). Root cause: the recovery poll right below this
  // deliberately never touches a turn while `chat.status` is
  // 'streaming'/'submitted' (2026-07-15 fix, see its own comment -- that
  // guard is correct and must stay, it stops a HEALTHY stream from being
  // clobbered mid-tool-call). The gap: a screen lock/backgrounded tab
  // doesn't always make the fetch reader actually throw -- mobile OSes
  // frequently just suspend the radio/socket into a silent limbo (no
  // bytes, no close, no error) rather than resetting it cleanly, so
  // `chat.status` can stay stuck on 'streaming' forever with the UI
  // frozen, even though route.ts's `consumeStream()`+background-drain
  // already guarantees the real work keeps running server-side and gets
  // persisted regardless. This ref tracks the last time `chat.messages`
  // ACTUALLY changed (a cheap length+content signature, not full JSON
  // diffing) -- if a turn has been 'streaming'/'submitted' with zero real
  // progress for longer than STALL_MS, that's the signal something died
  // client-side (not "a long tool call is still legitimately running",
  // which keeps updating parts/tool state well before STALL_MS), and it's
  // safe to fall through to the same proven reconciliation fetch used for
  // the 'error'/looksIncomplete cases below.
  const lastProgressRef = useRef<{ signature: string; at: number }>({ signature: '', at: Date.now() });

  const transport = useMemo(
    () =>
      new WorkflowChatTransport({
        // RETIRED (2026-07-22): the standalone Pxxl/Fly worker
        // (`${EVE_AGENT_HOST}/message`) this used to conditionally route to
        // is dead and this whole kill-switch is permanently disabled -- see
        // eve-agent-host.ts's file comment for the real production bug this
        // caused (every message send silently going to a dead external host
        // instead of this deployment's own /api/direct/chat). Always
        // same-origin now, no conditional left to accidentally re-arm.
        api: '/api/direct/chat',
        // MIGRATED (2026-08-07) off DefaultChatTransport onto
        // WorkflowChatTransport -- see turn-workflow.ts's file header for
        // the full "why a leg-based durable workflow" writeup. Behavior
        // this preserves unchanged: same api endpoint, same effective
        // body shape, same idle-timeout-guarded fetch (a mid-turn server
        // restart still needs this client-side watchdog regardless of
        // transport, since it's about detecting a fetch that silently
        // died with no bytes, no close, no error -- nothing to do with
        // reconnection itself). What it adds: WorkflowChatTransport's own
        // automatic reconnect-on-drop retry loop DURING an in-flight send
        // (reads this route's `x-workflow-run-id` response header, see
        // route.ts), on top of the existing on-mount `resume` behavior
        // below.
        //
        // WorkflowChatTransport has no static `body` option (unlike
        // DefaultChatTransport) -- `prepareSendMessagesRequest` is the
        // replacement, and it must be merged with any PER-CALL body a
        // caller passes to `chat.sendMessage(msg, { body })` (see the
        // `disabledTools` override further down this file) rather than
        // clobbering it.
        prepareSendMessagesRequest: ({ body }) => ({
          api: '/api/direct/chat',
          body: { ...body, ...(byokModelId ? { byokModelId } : { requestedModel }) },
        }),
        // ADDED (2026-07-24, real confirmed incident: a mid-turn Render
        // health-check-kill restarted the server -- the turn itself
        // survived and finished correctly server-side, but the open
        // fetch on THIS side never got a clean error, leaving the chat UI
        // stuck instead of recovering -- see fetch-with-idle-timeout.ts's
        // file comment for the full story. NOTE: STALL_MS below is a
        // separate, unrelated concept (client-side "did chat.messages
        // actually change" detection, not a wire-level watchdog) -- don't
        // assume the two need to match.
        // WIDENED (2026-07-26, part of the 'stops in 30s' investigation):
        // was a bare 20_000 literal, only ~1.3x the server's 15s heartbeat
        // interval -- a single slow/buffered heartbeat (Cloudflare sits in
        // front of entry.pxxl.pro and is known to coalesce small chunks
        // under some conditions) could trip this before a 2nd heartbeat
        // had a chance to land. Now sourced from the shared
        // CLIENT_IDLE_TIMEOUT_MS constant (see timing.ts) instead of a
        // bare literal here -- that file's own import-time assertion is
        // what actually guarantees this stays ahead of the server's
        // heartbeat cadence from now on, not just a comment saying so.
        fetch: fetchWithIdleTimeout(CLIENT_IDLE_TIMEOUT_MS),
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
    // RESUMABLE STREAM (2026-07-25, explicit user report: "if a task is
    // working in background I can still send multiple prompts and I get
    // multiple responses" + "if I reload the page [it] should not
    // disconnect [from a turn that's still running]"). `resume: true`
    // makes useChat call the transport's `reconnectToStream()` once on
    // mount. MIGRATED (2026-08-07): now WorkflowChatTransport's version
    // of that call (confirmed directly against
    // node_modules/@ai-sdk/workflow's workflow-chat-transport.ts) -- GETs
    // `/api/direct/chat/{chatId}/stream`, resolves the chat's durable
    // workflow run (see resolve-active-run.ts) and streams straight from
    // it via `getRun(runId).getReadable()`. A genuinely missing/expired
    // run still 204s. This is what lets a fresh page load (reload, new
    // tab, another device) discover a turn that's STILL running
    // server-side and attach to its live remaining output instead of
    // only finding out once it's fully done via the DB recovery poll
    // below -- and, just as importantly, it flips `chat.status` to
    // 'streaming' immediately on mount for a truly-still-running turn,
    // closing the exact window where `isBusy` could read false right
    // after a reload even though the server was still working (the bug
    // behind both reports above: the send button looking free to use,
    // and a second prompt racing the still-running first one).
    // FIXED (2026-08-05, reproduced from the screen recording): only
    // existing chats may resume. A brand-new `/chats` page still gets a
    // client-generated chat.id, but there is no server row or stream yet.
    // `resume: true` unconditionally made the AI SDK GET
    // `/api/direct/chat/<generated-id>/stream` on mount; the expected 404
    // was then surfaced as a failed/reconnecting turn before the user had
    // typed or sent anything. Existing chats retain durable resume for
    // reloads, tab switches, and background turns.
    resume: Boolean(sessionId && initialTurnActive),
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
      // A 409 from the new turn-lock guard (see route.ts / turn-lock.ts)
      // means a turn for this chat was ALREADY in flight when this send
      // fired -- never a real failure. Attach to the live turn instead of
      // surfacing a scary error for what the user correctly expects to
      // just keep working.
      if (error instanceof Error && error.message.includes('turn_in_progress')) {
        // Keep the UI locked and show "Reconnecting…" — the turn is
        // still running server-side, we just need to reattach.
        dispatchTurn({ type: 'SET_PENDING', value: true });
        dispatchTurn({ type: 'SET_RECONNECTING', value: true });
        if (!resumingRef.current) {
          resumingRef.current = true;
          void (async () => {
            try { await chat.resumeStream(); } catch {}
            finally { resumingRef.current = false; dispatchTurn({ type: 'SET_RECONNECTING', value: false }); }
          })();
        }
        return;
      }
      // RECONNECT-FIRST (2026-07-26, real user report: "it stops in 30s
      // ... after an hour it shows it worked for 16 minutes" -- the
      // `fetchWithIdleTimeout(20_000)` abort below is expected and
      // healthy for a long silent tool call (see that file's comment),
      // but this handler used to just show a scary "couldn't reach
      // server" error and stop, never attempting to reattach to the
      // turn that's still genuinely running server-side. Any transport-
      // shaped failure (idle-timeout abort, a dropped connection, a
      // transient network blip) should ALWAYS try to reattach to the
      // live Redis-mirrored stream first -- the `/stream` route is
      // idempotent (204 if the turn already finished) so this is safe to
      // call unconditionally. Only surface a real error banner if the
      // reattach itself throws (the one condition that actually rules
      // out "still working, just a rough patch on this connection").
      //
      // VISUAL RECONNECT INDICATOR (2026-07-27, "why do the send button
      // change to white like the model stop ... there is nothing visible
      // showing connecting or reconnected"): set isReconnecting=true
      // IMMEDIATELY so the UI shows "Reconnecting..." instead of the send
      // button going white/idle. This keeps pendingTurn true (via the
      // reducer) so the input stays locked, and the ThinkingIndicator
      // below gains a "Reconnecting..." label.
      // RE-ENTRANCY GUARD: if a previous onError retry loop is still
      // running, don't start another one — the existing loop will handle
      // reconnection. This prevents overlapping retry loops when
      // resumeStream() triggers onError again.
      if (resumingRef.current) return;
      resumingRef.current = true;
      dispatchTurn({ type: 'SET_RECONNECTING', value: true });
      turnLifecycleRef.current.lastResumeAttemptMs = Date.now();
      void (async () => {
        // RETRY WITH BACKOFF (2026-07-26, continuation of the same
        // reconnect-first fix): a single resumeStream() attempt can
        // itself transiently fail -- e.g. the reattach GET races a flaky
        // edge hop right as the original connection is being torn down
        // -- even though the turn-lock backing it is genuinely still
        // held and the turn is still running. Since resumeStream() is a
        // cheap idempotent GET (204 if there's truly nothing left, see
        // [chatId]/stream/route.ts), it's safe to retry a few times with
        // backoff before concluding it's a real error rather than giving
        // up on the very first hiccup.
        let lastResumeErr: unknown = null;
        for (const delayMs of [0, 1000, 3000, 6000]) {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          try {
            await chat.resumeStream();
            dispatchTurn({ type: 'SET_RECONNECTING', value: false });
            resumingRef.current = false;
            return;
          } catch (resumeErr) {
            lastResumeErr = resumeErr;
          }
        }
        console.error('[direct chat turn error] resumeStream retries exhausted', lastResumeErr);
        reportClientError(readableChatErrorMessage(error), { region: 'direct-chat-turn-error', stack: error instanceof Error ? error.stack : undefined });
        // ROOT CAUSE FIX (2026-07-27, "agent stops at 1 min but runs for
        // 21 min in background"): don't show a scary error or clear
        // pendingTurn. The turn is almost certainly still running server-
        // side — the connection just dropped on THIS tab. Set
        // SET_RECONNECTING instead so the UI shows "Reconnecting…" and
        // the send button stays locked. The recovery poll (which runs
        // every 800ms while pendingTurn is true) will catch up via DB
        // snapshots — a simple GET that doesn't depend on streaming
        // through the same proxy that just dropped the live stream.
        resumingRef.current = false;
        dispatchTurn({ type: 'SET_RECONNECTING', value: true });
      })();
    },
    async onFinish({ message }) {
      // CLEAR pendingTurn (2026-07-27, "send button doesn't allow after
      // agent finishes"): the turn is done — clear the busy state so the
      // send button unlocks immediately, not after SETTLE_QUIET_MS (4.5s).
      dispatchTurn({ type: 'SET_PENDING', value: false });
      dispatchTurn({ type: 'CLEAR_ERROR' });
      // SURFACED (2026-07-27, real report: "I selected a BYOK model but
      // the chat used HCNSec deepseek instead") -- that wasn't the
      // picker being ignored, it was route.ts's cooldown-fallback
      // substitution firing silently (see its own comment). Now that the
      // server actually attaches a `substitutionNotice` to this turn's
      // metadata when that happens, show it so a swap is never mistaken
      // for a broken model selector again.
      const notice = (message?.metadata as { substitutionNotice?: string } | undefined)?.substitutionNotice;
      if (notice) toast(notice);
      // Safety net only now (2026-07-23): onSend already does this
      // eagerly the moment the message is sent, so createdRef.current is
      // normally already true by the time onFinish runs. Kept as a
      // fallback for any send path that doesn't go through onSend (e.g.
      // the initialMessage/integrationCallback auto-sends below).
      if (!createdRef.current) {
        createdRef.current = true;
        if (!sessionId) silentlyUpdateChatUrl(`/chats/${chat.id}`);
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
      // Extended retry window (400ms→5s): covers card appended late by
      // Vercel after(). >= not > so we adopt even when message count is
      // equal (version card appended = same count but new content).
      for (const delayMs of [400, 900, 1600, 3000, 5000]) {
        await new Promise(r => setTimeout(r, delayMs));
        try {
          const res = await fetch(`/api/chats/${activeId}`);
          if (!res.ok) continue;
          const snap = await res.json();
          const persisted = Array.isArray(snap?.events) ? snap.events : null;
          if (persisted && persisted.length >= chat.messages.length && isSafeToAdopt(persisted, chat.messages)) {
            chat.setMessages(mergeMessagesAppendOnly(chat.messages, persisted));
            return;
          }
        } catch {
          // best-effort, try the next delay
        }
      }
    },
  });

  // Available from this component's very first render (chat.id is
  // client-generated synchronously by useChat, never awaits anything) --
  // this is what makes it safe to key the header/preview/library-insert
  // off `activeId` immediately on send, instead of waiting for the turn
  // to finish and the server to hand back a confirmed id.
  const activeId = sessionId ?? chat.id;

  // Updates the STALL DETECTION signature above every time the messages
  // array actually changes content -- cheap length+last-part signature,
  // deliberately not a full JSON stringify (this runs on every streamed
  // token). Any real progress at all (a new text-delta, a tool call
  // advancing state, a whole new message) resets the stall clock; a
  // client-side-dead stream is exactly the case where NONE of that ever
  // fires again.
  useEffect(() => {
    const last = chat.messages[chat.messages.length - 1];
    const lastPart = last?.parts?.[last.parts.length - 1] as { text?: string } | undefined;
    const signature = `${chat.messages.length}:${last?.parts?.length ?? 0}:${lastPart?.text?.length ?? 0}`;
    if (signature !== lastProgressRef.current.signature) {
      lastProgressRef.current = { signature, at: Date.now() };
    }
  }, [chat.messages]);

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
        // BUG FIX (owner report 2026-07-26: "I didn't send any chat but
        // once my chat load it shows [the connection-error banner]"):
        // a genuinely brand-new chat -- zero messages, nothing ever sent
        // -- was NEVER persisted server-side in the first place, so
        // `/api/chats/${activeId}` legitimately 404s for it, every single
        // poll, forever. After 8 misses this recovery loop (whose whole
        // purpose is recovering an INTERRUPTED turn) was firing the scary
        // "Couldn't send that message" error at someone who never sent
        // anything at all. There is nothing to recover when there are no
        // messages yet -- skip the recovery loop entirely in that case.
        if (chat.messages.length === 0) return;
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
        // Only ever SKIP the check outright while a turn is actively,
        // healthily streaming (that's the one case where clobbering with a
        // 3s-old snapshot is provably wrong -- see the 2026-07-15 bug this
        // guard exists to prevent, in the block below). Every other state
        // -- 'ready' included -- falls through to the fetch below and gets
        // reconciled against the DB every single tick, unconditionally.
        //
        // FIXED (2026-07-24, real user-confirmed bug: "it's in the DB but
        // not displaying in the chat" -- reproduced by reading the actual
        // row: the DB genuinely had more/newer content than what the tab
        // was showing, with chat.status sitting on 'ready' the whole time,
        // not stuck on 'error'/'streaming' at all). The OLD second gate
        // here (`if (chat.status !== 'error' && !looksIncomplete &&
        // !isStale) return;`) meant: once a turn settled into 'ready' with
        // what LOOKED like a complete last assistant message, this poll
        // permanently stopped reconciling against the DB for that turn --
        // forever, even though the server can keep running and persisting
        // MORE after the client's own view of a turn settled (route.ts's
        // after()+consumeStream() durability model means the server-side
        // turn is not bound by the client's connection at all). A
        // reconnect after that point (new tab, page still open, whatever)
        // had genuinely no path left to ever catch up to what the DB
        // already had. Removing that gate makes 'ready' behave exactly
        // like every other non-actively-streaming state: always adopt the
        // DB's content once the merge check below finds a real diff. This
        // is safe specifically BECAUSE it only runs when NOT actively
        // streaming -- there is no live writer to race against.
        // DERIVED from timing.ts's WRITER_HEARTBEAT_MS (2026-07-27): must
        // be at least 3x the heartbeat interval so a few missed heartbeats
        // (Cloudflare buffering, a slow tick) don't trigger premature
        // stall detection. With 5s heartbeats, 15s gives 3 full cycles of
        // slack — same ratio as the old 24s/8s pairing, just tighter
        // overall since the whole cascade is now faster and more responsive.
        const STALL_MS = 15_000;
        const isStale = Date.now() - lastProgressRef.current.at > STALL_MS;
        if ((chat.status === 'streaming' || chat.status === 'submitted') && !isStale) return;
        try {
          const res = await fetch(`/api/chats/${activeId}`);
          if (!res.ok) {
            // Only a genuine 404 (this exact chat id truly does not exist
            // server-side, e.g. the initiating POST never reached the
            // server at all -- see send-with-retry.ts) is evidence this
            // will NEVER resolve. Anything else (502/503/504 from a flaky
            // proxy hop, a transient 500, etc.) says nothing about whether
            // the chat/turn itself is fine -- treat it exactly like the
            // network-level catch block below: log, don't touch the
            // give-up counter, just retry on the next tick.
            if (res.status !== 404) {
              console.warn('[direct-chat recovery poll] non-404 non-OK response, retrying next tick', res.status);
              return;
            }
            // Wall-clock-based, not raw-poll-count-based (2026-08-05 fix,
            // see firstNotFoundAtRef's own comment above): immune to the
            // adaptive 800ms/3000ms cadence swing that made the old "8
            // consecutive polls" threshold mean anywhere from ~6.4s to
            // ~24s of real grace depending on which cadence happened to be
            // active. 30s of CONTINUOUS real 404s is well past any
            // plausible transient blip.
            if (firstNotFoundAtRef.current === null) firstNotFoundAtRef.current = Date.now();
            if (Date.now() - firstNotFoundAtRef.current >= 30_000) {
              gaveUpRef.current = true;
              window.clearTimeout(pollIdRef.current);
              dispatchTurn({
                type: 'RECONNECT_GAVE_UP',
                message: looksIncomplete ? "Couldn't send that message -- check your connection and try again." : undefined,
              });
            }
            return;
          }
          firstNotFoundAtRef.current = null;
          missedPollsRef.current = 0;
          const snap = await res.json();
          const persisted = Array.isArray(snap?.events) ? snap.events : null;
          // NEW-CHAT INDICATOR FIX (2026-07-28, owner bug report: thinking
          // indicator spinning forever on a chat with no messages loaded).
          // The seed heuristic (line ~340, `last.role === 'user'`) can guess
          // pendingTurn=true for any chat where the last persisted message is
          // a user turn within the last 2h -- but it says nothing about
          // WHETHER the snapshot API returns events at all for that chat. A
          // chat with events=[] (fresh/unused session, or the snapshot shape
          // doesn't include an events key) would trigger the early return
          // here, which sits BEFORE the settle check: the content-diff logic
          // needs a non-empty persisted array, but the settle check
          // (lastGrowthAtRef + SETTLE_QUIET_MS + /turn-status ping) does
          // NOT -- it only needs to know whether time has passed with no DB
          // growth. An empty persisted array is trivially "not newer than"
          // whatever the client has, so it safely falls through to the ELSE
          // (settle) branch below, same as any other no-change tick. The
          // only acceptable early exit is `persisted === null` (the endpoint
          // didn't return an events array at all, e.g. a shape mismatch).
          if (!persisted) return;
          // Content-level compare, not just a length check -- now that
          // this also runs during 'ready', the failure mode to guard
          // against shifted: the LAST message can grow more parts (a
          // background continuation appending to the same message id)
          // without the top-level array length changing at all, which a
          // bare length check would silently miss forever. Cheap enough
          // at this scale (one JSON.stringify each way, once per 3s tick,
          // only while not actively streaming) and it's the only way to
          // actually guarantee "whatever's in the DB always eventually
          // shows here" rather than "whatever's in the DB shows here
          // unless it happened to grow inside the last message only".
          const persistedIsNewer =
            (persisted.length > chat.messages.length ||
              (persisted.length === chat.messages.length && JSON.stringify(persisted) !== JSON.stringify(chat.messages))) &&
            isSafeToAdopt(persisted, chat.messages);

          // STALE-ERROR-BANNER FIX (2026-07-26, real user report: turn
          // genuinely ran ~20min server-side, all tool calls rendered and
          // completed correctly via this very poll, yet a "Couldn't reach
          // the server" banner sat there at the end regardless). Root
          // cause: `resume: true`'s own reattached stream (AI SDK's
          // resumeStream(), a SEPARATE GET from this poll's `/api/chats`
          // fetch, going over the SAME `fetchWithIdleTimeout(20_000)`
          // transport) can hit its own 20s-idle abort independently --
          // e.g. a long tool call with no incremental bytes on the wire
          // for >20s -- and that surfaces through `onError` as a real
          // transport failure, setting `turnError`, even while THIS poll
          // (a totally different request) keeps succeeding and rendering
          // fine the whole time via `chat.setMessages`. The two paths
          // never talked to each other: `turnError` only got cleared
          // above inside the `persistedIsNewer` branch, so if that one
          // resumed-stream error happened to fire during a tick where
          // nothing new had landed yet (or after the DB poll had already
          // caught everything up), the banner just sat there forever with
          // no future event left to clear it, even though the DB -- the
          // actual server-side ground truth -- already shows the turn
          // completed cleanly. The DB always wins: if the last persisted
          // message is a real, non-empty assistant reply and we're not
          // actively mid-stream right now, whatever transport hiccup set
          // turnError is moot -- clear it unconditionally, on every tick,
          // not just the "new content just landed" branch.
          const dbLastMsg = persisted[persisted.length - 1];
          const dbLooksComplete = dbLastMsg?.role === 'assistant' && messageTextLength(dbLastMsg) > 0;
          const activelyStreamingNow = chat.status === 'streaming' || chat.status === 'submitted';
          if (dbLooksComplete && !activelyStreamingNow && turnLifecycleRef.current.turnError) {
            dispatchTurn({ type: 'CLEAR_ERROR' });
            chat.clearError();
          }

          if (persistedIsNewer) {
            // Genuinely new content just showed up server-side since the
            // last check. Two different situations produce this, and they
            // need different `pendingTurn` handling:
            //  1. A turn is genuinely still being worked on (chat.status is
            //     'streaming'/'submitted', e.g. after a reload landed
            //     mid-turn) -- real ongoing work, keep the send button
            //     locked (pendingTurn true) until it settles.
            //  2. The turn already fully finished (chat.status is 'ready')
            //     and this is just catching up a message the server
            //     appended slightly AFTER the stream closed -- e.g. the
            //     file-change "version card" appended via an `after()`
            //     callback (see onFinish's own catch-up loop above, which
            //     already handles the fast path; this poll is only the
            //     backstop for when that loop doesn't run). There is no
            //     more work coming after this -- chat.status already told
            //     us so -- so forcing pendingTurn(true) here just re-locks
            //     an already-idle send button for no reason, for as long
            //     as SETTLE_QUIET_MS takes to expire again. FIXED
            //     (2026-07-24, real user report: "if the agent finish the
            //     turn or stop, if I want to send another message, the
            //     send button doesn't allow" -- reproduced exactly via
            //     this path: a version card landing right after finish
            //     flipped isBusy back to true for several seconds with no
            //     visible cause). Only keep the busy-lock when chat.status
            //     itself says work is still active.
            // Server content is proof that the turn is still producing or
            // finalizing work. Do not consult this tab's local `chat.status`
            // here: after a dropped stream it can be `ready` while the
            // server is still writing newer snapshots. Keep pendingTurn
            // true until the authoritative turn-status check reports
            // inactive, so the timer and send button cannot go idle
            // mid-generation.
            const stillActive = true;
            lastGrowthAtRef.current = Date.now();
            chat.setMessages(mergeMessagesAppendOnly(chat.messages, persisted));
            dispatchTurn({ type: 'RECONNECT_PROGRESS', stillActive });
            chat.clearError();
            // Mirror onFinish's own first-turn navigation: if the client's
            // onFinish never got to run (the stream broke before it could
            // fire), the URL would otherwise be stuck on the "new chat"
            // route forever despite the chat now genuinely being persisted
            // under `activeId` -- a refresh later would lose it from view.
            if (!createdRef.current) {
              createdRef.current = true;
              if (!sessionId) silentlyUpdateChatUrl(`/chats/${activeId}`);
            }
          } else if (Date.now() - lastGrowthAtRef.current > SETTLE_QUIET_MS) {
            // AUTHORITATIVE SETTLE CHECK (2026-07-26, real user report:
            // "it stops in 30s ... after an hour it shows it worked for
            // 16 minutes"). This used to declare "settled" (pendingTurn
            // -> false, UI looks fully idle) from wall-clock quiet time
            // ALONE -- correct for the 3s incremental-save throttle gap
            // this was originally written for, but dead wrong for a
            // legitimately long-running SILENT tool call (a sandbox run,
            // browser_use, a slow search) that can go minutes between DB
            // saves while still very much alive. Before giving up, ask
            // the one place that actually knows: the Redis turn-lock
            // (same one route.ts renews via `startTurnHeartbeat` for as
            // long as the turn's own async work is alive, independent of
            // this tab's connection). Only genuinely declare idle when
            // the server confirms there's no active turn; otherwise keep
            // the busy-lock and let the next tick re-check, no matter how
            // long the quiet stretch runs.
            try {
              const statusRes = await fetch(`/api/direct/chat/${activeId}/turn-status`);
              const stillActive = statusRes.ok && (await statusRes.json())?.active === true;
              // DB-WINS CIRCUIT BREAKER (2026-07-27, real user-recorded bug:
              // a provider that errors out on every attempt produced a
              // NEW "No response came back this turn" bubble every ~2.6s,
              // seemingly forever). Root cause: this branch trusted the
              // server's turn-lock `active` flag alone to decide whether to
              // call `resumeStream()` again -- but a lock can keep reading
              // `active: true` for a stretch after the turn has already
              // written its final (even if it's an error-fallback) message
              // to the DB, and every extra `resumeStream()` call re-pulls
              // that same already-rendered terminal content, which
              // `useChat`'s reconnect handling has no way to recognize as
              // "already shown" -- so it renders as a brand new message
              // each time, forever, as long as the stale lock keeps
              // reporting active. The DB is ground truth (same principle
              // the `dbLooksComplete` check just above this already
              // applies for clearing turnError): if the last persisted
              // message is already a real, non-empty assistant reply and
              // we're not actively mid-stream right now, the turn is done
              // no matter what the lock says -- never call `resumeStream()`
              // again for it.
              if (stillActive && !(dbLooksComplete && !activelyStreamingNow)) {
                dispatchTurn({ type: 'SET_PENDING', value: true });
                // DB POLL IS THE PRIMARY RECOVERY MECHANISM (2026-07-27,
                // root cause fix for "agent stops at 1 min but runs for
                // 21 min in background"): do NOT call resumeStream() here
                // anymore. The live stream and resumeStream() both go
                // through the same proxy that just dropped the connection
                // — calling resumeStream() repeatedly creates a failure
                // cycle (resumeStream fails → onError fires → SET_ERROR
                // → pendingTurn cleared → recovery poll slows down →
                // rinse repeat). Instead, rely SOLELY on DB snapshot
                // polling (this poll's own GET /api/direct/chat/{id}/
                // snapshot), which is a simple non-streaming GET that
                // works regardless of proxy buffering. Content will
                // appear in 800ms increments — not as smooth as live
                // streaming, but it NEVER silently stops while the
                // server keeps working. Only try resumeStream() if we
                // haven't tried it recently (30s cooldown) — a fresh
                // page load or tab focus should still get a chance to
                // attach to the live stream.
                if (
                  chat.status !== 'streaming' &&
                  chat.status !== 'submitted' &&
                  Date.now() - (turnLifecycleRef.current.lastResumeAttemptMs ?? 0) > 30_000
                ) {
                  turnLifecycleRef.current.lastResumeAttemptMs = Date.now();
                  void chat.resumeStream();
                }
              } else {
                dispatchTurn({ type: 'SET_PENDING', value: false });
              }
            } catch {
              // Network hiccup checking status -- don't falsely declare
              // idle off the back of a failed status check; try again
              // next tick.
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
    // focus fires on mobile when the user returns to the tab even when
    // visibilitychange doesn't (some Android WebViews, PWA mode).
    const onFocus = () => tryRecover();
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    // Belt-and-suspenders third trigger, independent of the browser
    // actually firing 'online'/'visibilitychange' at all: some networks
    // drop/restore Wi-Fi or cellular without ever firing a real 'offline'
    // -> 'online' transition (silent DNS/route flap), and a laptop
    // sleep/wake cycle can resume with the tab still reporting 'visible'
    // the whole time. Poll while a turn looks active (or looks
    // interrupted-mid-turn on a fresh mount, see looksIncomplete above) so
    // a dead connection still self-heals even when neither event ever
    // fires -- cheap (one lightweight GET), and tryRecover() itself is a
    // no-op once nothing new is available. Also fire once immediately
    // (not just after the first interval tick) so a reload lands on an
    // up-to-date answer as fast as possible instead of waiting doing
    // nothing first.
    //
    // FIXED (2026-07-24, real user request: "if I reload the page, the
    // response should still stream well -- I'm connected back and have
    // connections"). A fixed 3s cadence made a reload-mid-turn feel like
    // one long stall followed by a single big jump once the interval
    // finally ticked -- technically self-healing, but nothing about it
    // felt like a live stream resuming. Switched from a fixed
    // setInterval to a self-rescheduling setTimeout so the cadence can
    // adapt: a fresh mount that lands mid-turn (or any turn that's
    // still actively incomplete) re-polls every 800ms -- fast enough that
    // successive catch-up snapshots (each capturing a bit more of the
    // growing text/tool state) read as a near-continuous stream instead
    // of occasional jumps, without hammering the DB once things settle
    // (falls back to the original 3s cadence the moment nothing looks
    // incomplete anymore).
    let cancelled = false;
    gaveUpRef.current = false;
    const scheduleNext = () => {
      if (cancelled || gaveUpRef.current) return;
      const last = chat.messages[chat.messages.length - 1];
      // WIDENED (2026-07-26): used to only fast-poll while waiting on the
      // very first reply (last message still from 'user'). Also fast-poll
      // whenever pendingTurn thinks a turn is active -- e.g. mid-tool-call
      // background work -- so catch-up snapshots read as a near-continuous
      // stream instead of one big 3s-later jump.
      const stillCatchingUp = !last || last.role === 'user' || turnLifecycleRef.current.pendingTurn;
      pollIdRef.current = window.setTimeout(() => {
        tryRecover();
        scheduleNext();
      }, stillCatchingUp ? 800 : 3000);
    };
    tryRecover();
    missedPollsRef.current = 0;
    firstNotFoundAtRef.current = null;
    scheduleNext();
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.clearTimeout(pollIdRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, chat.id, chat.status]);

  const { requestOpenHistory } = useChatPanel();

  const isBusy = chat.status === 'submitted' || chat.status === 'streaming' || pendingTurn;
  // RETIRED (2026-07-22): this used to overlay a synthetic live-preview
  // message while a turn was handed off to a durable Trigger.dev
  // background worker past Vercel's 300s limit. Now fully on Render (a
  // persistent server process, no request timeout), a turn just runs
  // inline for as long as it needs -- there is no handoff case to render
  // a preview for anymore.
  const messages = chat.messages;
  const lastMessage = messages[messages.length - 1];
  // NOTE: `pendingTurn` itself (true right after a fresh mount/reload that
  // landed mid-turn, or any time the recovery poll below detects the
  // server producing new content this tab hasn't caught up to yet) is now
  // the `useState` declared up near the other recovery-poll refs -- it
  // already feeds `isBusy` above, which is strictly more complete than a
  // one-shot "last message is from user" snapshot ever was (it also
  // correctly covers a reload landing mid-ASSISTANT-stream, not just
  // before the first token, and only clears once the recovery poll
  // confirms real settle time has passed -- see that state's own comment
  // for why). Distinct from `showThinkingIndicator` below, which only
  // ever covers a turn that started IN this same instance.
  // "Thinking…" indicator: visible from the moment a message is sent until
  // the assistant's reply actually has SOMETHING to show (text, a tool
  // call, or reasoning) — covers response latency, then gets out of the
  // way the instant real content starts arriving.
  // FIXED (2026-07-27, "when I send a message it will automatically stop
  // and not know the model is working in background. And nothing show
  // for me to know"): the old condition only showed the thinking indicator
  // when the LAST message was NOT an assistant message. But when sending
  // a NEW message in an existing conversation, the last message IS an
  // assistant from the PREVIOUS turn — so the indicator never showed
  // until the new assistant message was created, leaving a gap where the
  // user sees nothing happening. Now also shows when pendingTurn is true
  // (the eager signal from onSend) even if the last message is an
  // assistant reply from before. The `lastMessage.parts.length === 0`
  // branch still covers the case where the assistant message was created
  // but hasn't received any content yet.
  const showThinkingIndicator =
    isBusy && (pendingTurn || !lastMessage || lastMessage.role !== 'assistant' || lastMessage.parts.length === 0);

  // Turn timer (see turn-timer.tsx's file comment) -- live wall-clock
  // count from the moment this turn became busy (submitted or
  // streaming), independent of chunk arrival so it can never stall.
  const liveTurnElapsedMs = useLiveTurnElapsedMs(isBusy);

  // FROZEN-ON-STOP FALLBACK (2026-07-23, real user-reported bug: "if a
  // turn stops without completing, the timer never shows at the bottom
  // at all"). route.ts's messageMetadata now also fires on a genuine
  // 'error' part (see that file's comment), which covers a clean, caught
  // error -- but the one case NO server-side hook can ever cover is a
  // truly dead turn that never gets far enough to emit even an error
  // chunk at all (a hard network cut on the provider side with nothing
  // ever coming back). That case flips `isBusy` false (chat.status goes
  // to 'error'/'ready') with `message.metadata.durationMs` never set --
  // previously a permanent blank gap, since the live ticking clock is
  // gated on `isBusy` and stops rendering the instant it goes false.
  // Fix: the moment `isBusy` transitions true -> false, if the last
  // assistant message still has no durationMs yet, snapshot the live
  // clock's last real value and keep showing THAT as a normal (no longer
  // ticking) duration label -- a genuine wall-clock number, not a guess,
  // just sourced client-side instead of server-side for this one
  // worst-case gap. Cleared the instant a NEW turn starts (isBusy flips
  // back to true) so it never bleeds into the next message's own timer,
  // and it's naturally superseded the moment a real reload/refetch
  // brings back a proper server-computed durationMs for that message
  // (the metadata check always wins first in the render below).
  const frozenDurationRef = useRef<{ messageId: string; ms: number } | null>(null);
  const wasBusyRef = useRef(isBusy);
  useEffect(() => {
    if (wasBusyRef.current && !isBusy) {
      const last = chat.messages[chat.messages.length - 1];
      const alreadyHasDuration =
        last?.role === 'assistant' &&
        typeof (last.metadata as { durationMs?: number } | undefined)?.durationMs === 'number';
      if (last?.role === 'assistant' && !alreadyHasDuration && liveTurnElapsedMs != null) {
        frozenDurationRef.current = { messageId: last.id, ms: liveTurnElapsedMs };
      }
    }
    if (isBusy) {
      frozenDurationRef.current = null;
    }
    wasBusyRef.current = isBusy;
  }, [isBusy, chat.messages, liveTurnElapsedMs]);

  const sentInitialRef = useRef(false);
  useEffect(() => {
    if (initialMessage && !sentInitialRef.current && initialMessages.length === 0) {
      sentInitialRef.current = true;
      // Same instant-creation bookkeeping as onSend above -- this is the
      // seeded-deep-link auto-send path (?msg=... on a brand-new chat),
      // which bypasses onSend entirely by calling sendMessage directly.
      if (!sessionId && !createdRef.current) {
        createdRef.current = true;
        silentlyUpdateChatUrl(`/chats/${chat.id}`);
        useLibraryStore.getState().addLocalChat(chat.id, initialMessage.slice(0, 80) || null);
      }
      // Same guards as onSend: eager busy signal, clear old errors,
      // and retry on network failure (see onSend's own comments).
      dispatchTurn({ type: 'SET_PENDING', value: true });
      dispatchTurn({ type: 'CLEAR_ERROR' });
      void sendWithRetry(() => chat.sendMessage({ text: initialMessage })).catch(err => {
        if (err instanceof Error && err.message.includes('turn_in_progress')) {
          dispatchTurn({ type: 'SET_PENDING', value: true });
          if (!resumingRef.current) {
            resumingRef.current = true;
            void (async () => {
              try { await chat.resumeStream(); } catch {}
              finally { resumingRef.current = false; dispatchTurn({ type: 'SET_RECONNECTING', value: false }); }
            })();
          }
          return;
        }
        console.error('[direct chat initial send failed]', err);
        reportClientError(readableChatErrorMessage(err), { region: 'direct-chat-initial-send-failed', stack: err instanceof Error ? err.stack : undefined });
        dispatchTurn({ type: 'SET_ERROR', message: readableChatErrorMessage(err) });
      });
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
    dispatchTurn({ type: 'SET_PENDING', value: true });
    dispatchTurn({ type: 'CLEAR_ERROR' });
    void sendWithRetry(() => chat.sendMessage({ text })).catch(err => {
      if (err instanceof Error && err.message.includes('turn_in_progress')) {
        dispatchTurn({ type: 'SET_PENDING', value: true });
        if (!resumingRef.current) {
          resumingRef.current = true;
          void (async () => {
            try { await chat.resumeStream(); } catch {}
            finally { resumingRef.current = false; dispatchTurn({ type: 'SET_RECONNECTING', value: false }); }
          })();
        }
        return;
      }
      console.error('[integration callback send failed]', err);
      reportClientError(readableChatErrorMessage(err), { region: 'direct-chat-integration-callback-failed', stack: err instanceof Error ? err.stack : undefined });
      dispatchTurn({ type: 'SET_ERROR', message: readableChatErrorMessage(err) });
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
  // Auto-follow while streaming -- shared engine (2026-07-19): the inline
  // MutationObserver here used the same broken 120px near-bottom check
  // the eve path had (large tool-card/markdown appends outran the
  // threshold in one frame and silently killed following mid-turn --
  // "doesn't auto scroll at all"). Replaced with
  // use-streaming-autoscroll.ts's sticky user-intent version; one
  // implementation for both chat paths so they can't re-diverge.
  useStreamingAutoScroll(scrollRef, `${messages.length}:${showThinkingIndicator}`);

  const onSend = (input: string, opts?: { attached?: AttachedContext[]; disabledTools?: string[]; model?: string; images?: ChatImageAttachment[] }) => {
    // CLIENT-SIDE DOUBLE-SEND GUARD (2026-07-25, explicit user report:
    // "if a task is working in background I can still send multiple
    // prompt and I get multiple responses so it's confusing"). `isBusy`
    // already gates the input's own `sending` prop (disables the visible
    // send affordance), but that's advisory only -- anything that still
    // calls `onSend` directly while a turn is genuinely in flight (a
    // stale keyboard-submit event, a race right as a turn starts/ends)
    // used to fall straight through to `chat.sendMessage`, which is
    // exactly how a second, PARALLEL turn got started against the same
    // chat. This is the actual hard stop: bail before touching
    // `chat.sendMessage` at all whenever `isBusy` is true. The server-side
    // lock (turn-lock.ts) is the real, authoritative guard against a
    // second concurrent turn (covers races this can't, like a second
    // tab) -- this is just the fast, no-network first line of defense for
    // the overwhelmingly common single-tab case.
    if (isBusy) return;
    // Switching to a different model mid-chat is handled by the parent
    // (chat-interface.tsx remounts into the right path); here we only ever
    // send under the current byokModelId/requestedModel.
    // INSTANT BUSY SIGNAL (2026-07-27, "when I send a message it will
    // automatically stop and not know the model is working in background.
    // And nothing show for me to know"): there's a gap between calling
    // chat.sendMessage() and chat.status actually flipping to 'submitted'
    // (the AI SDK's own internal async). During that gap, isBusy reads
    // false, the ThinkingIndicator doesn't show, and the input looks
    // free — exactly the "nothing shows" complaint. Set pendingTurn
    // eagerly RIGHT HERE so the busy state is visible from the instant
    // the user hits send, not after the next render cycle.
    dispatchTurn({ type: 'SET_PENDING', value: true });
    dispatchTurn({ type: 'CLEAR_ERROR' });

    // INSTANT chat creation (2026-07-23, explicit user request: "the chat
    // should be created instantly I send message ... I need to reload the
    // page for those header of preview and all other to show for new
    // chat"). Previously this same bookkeeping only ran in onFinish, i.e.
    // only once the model's ENTIRE reply had finished streaming -- so for
    // however long the first turn took, the URL still said `/chats` (no
    // id) and the library/sidebar list had no idea this chat existed at
    // all. Neither piece here needs to wait:
    //  - `chat.id` is generated synchronously by useChat, true from this
    //    component's very first render (see the `activeId` comment above).
    //  - the server's preSave already persists the EveChatSession row
    //    before this request's response even starts coming back, so
    //    there's no real race being papered over -- purely a UI-latency
    //    fix, moving bookkeeping that was ALREADY guaranteed to be correct
    //    to the earliest possible moment instead of the last.
    // silentlyUpdateChatUrl is still the address-bar-only History API
    // trick (no Next router navigation, no remount) -- see its own file
    // comment for why a real router.replace here would be wrong (it would
    // unmount/remount this whole component, losing the live in-progress
    // stream on every single first message). ChatPageHeader/preview now
    // read `activeId` directly instead of the URL, so they don't need the
    // real route to have changed to appear.
    if (!sessionId && !createdRef.current) {
      createdRef.current = true;
      silentlyUpdateChatUrl(`/chats/${chat.id}`);
      useLibraryStore.getState().addLocalChat(chat.id, input.slice(0, 80) || null);
    }
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
      // TURN_IN_PROGRESS HANDLING (2026-07-27, "I believe there is a big
      // bug there" — the user was right): when the user clicks send while
      // a previous turn's lock is still held (UI looks idle but server is
      // still working), the 409 was silently swallowed — the user clicked
      // send and NOTHING happened: no feedback, no reattachment, no error.
      // Now: re-lock the send button (pendingTurn = true), show
      // "Reconnecting…" so the user knows something is happening, and
      // try to reattach to the still-running turn's stream. This is NOT
      // a duplicate send — the server already rejected it.
      if (err instanceof Error && err.message.includes('turn_in_progress')) {
        dispatchTurn({ type: 'SET_PENDING', value: true });
        dispatchTurn({ type: 'SET_RECONNECTING', value: true });
        // Try to reattach to the live turn — idempotent (204 if already
        // done), safe to call even if we just reattached.
        if (!resumingRef.current) {
          resumingRef.current = true;
          void (async () => {
            try {
              await chat.resumeStream();
            } catch {
              // resumeStream failed — the recovery poll (800ms) will
              // catch up via DB snapshots. Don't clear pendingTurn.
            } finally {
              resumingRef.current = false;
              dispatchTurn({ type: 'SET_RECONNECTING', value: false });
            }
          })();
        }
        return;
      }
      console.error('[direct chat send failed]', err);
      reportClientError(readableChatErrorMessage(err), { region: 'direct-chat-send-failed', stack: err instanceof Error ? err.stack : undefined });
      dispatchTurn({ type: 'SET_ERROR', message: readableChatErrorMessage(err) });
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
      {/* Rendered here (not prop-drilled from the page level) because a
          brand-new chat's parent page.tsx (app/(app)/chats/page.tsx) can't
          possibly know the chat's id yet to pass it down -- `activeId` is
          only ever known once this component (and its `chat` instance)
          exists. Wrapped in Suspense because ChatPageHeader reads
          `useSearchParams` internally. Always mounts once activeId is
          truthy, which per the AI SDK is from this component's very first
          render (2026-07-23, "chat should be created instantly I send
          message ... header of preview should show", no reload needed). */}
      <Suspense fallback={null}>
        <ChatPageHeader sessionId={activeId} />
      </Suspense>
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
                      if (part.type === 'text') {
                        // Long USER messages collapse behind "Show more"
                        // (collapsible-user-text.tsx) -- assistant text
                        // renders in full, always.
                        if (m.role === 'user') {
                          return <CollapsibleUserText key={i} text={part.text} full={<MarkdownText text={part.text} />} />;
                        }
                        return <MarkdownText key={i} text={part.text} />;
                      }
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
                        // Auto-open while actively running, auto-close on
                        // completed/error (2026-07-19) -- the previous
                        // uncontrolled `defaultOpen` opened the card as the
                        // call started but left it open forever afterwards;
                        // AutoCollapseTool drives open-ness from the part's
                        // live state instead, with a manual toggle always
                        // winning for that card (see tool.tsx).
                        return (
                          <AutoCollapseTool key={i} className="my-1" state={state}>
                            <ToolHeader title={toolName} state={state} errorText={errorText} />
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
                          </AutoCollapseTool>
                        );
                      }
                      return null;
                    })}
                    {isLastAssistant && showThinkingIndicator && <ThinkingIndicator label={isReconnecting ? 'Reconnecting…' : undefined} />}
                    {m.role === 'assistant' && (() => {
                      const durationMs = (m.metadata as { durationMs?: number } | undefined)?.durationMs;
                      if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
                        return <TurnDurationLabel durationMs={durationMs} />;
                      }
                      if (isLastAssistant && isBusy && liveTurnElapsedMs != null) {
                        return <LiveTurnDurationLabel elapsedMs={liveTurnElapsedMs} />;
                      }
                      // Worst-case fallback (see frozenDurationRef's own
                      // comment above): the turn ended without the server
                      // ever attaching a durationMs at all -- show the
                      // frozen client-side snapshot instead of nothing.
                      if (isLastAssistant && frozenDurationRef.current?.messageId === m.id) {
                        return <TurnDurationLabel durationMs={frozenDurationRef.current.ms} />;
                      }
                      return null;
                    })()}
                  </div>
                </div>
              );
            })}
            {/* FIXED (2026-07-24, real user-reported bug: "I reload the
                website and the model stops working -- but maybe it's still
                working in the background?"). That's exactly what was
                happening: the recovery effect above (see `pendingTurn`)
                correctly detects a fresh mount that landed mid-turn (last
                message is the user's own, nothing after it yet) and its 3s
                poll DOES keep reconciling against the DB in the background
                -- the server-side turn genuinely keeps running the whole
                time (see route.ts's consumeStream()-based durability). But
                this render only ever showed a spinner while `isBusy` was
                true, which resets to false on every fresh mount (chat.status
                always re-initializes to 'ready' on reload, regardless of
                what's actually happening server-side) -- so a reload landed
                on total silence: just the user's last message, nothing
                after it, for however long it took the poll to catch up.
                From the outside that's indistinguishable from "stopped
                dead". Extending this condition to also cover `pendingTurn`
                (computed above, independent of `isBusy`) means a reload
                shows the exact same spinner a live turn would, for as long
                as it takes tryRecover's poll to bring back the real
                content -- which is the truth: something IS still
                happening, it just isn't this component instance's own
                stream. No new text/copy added (per the 2026-07-15 banner
                removal above), just the same visual "something is
                happening" cue reused for a case that was silently missing
                it entirely. */}
            {/* WIDENED (2026-07-26, real dead-zone found while chasing the
                same "looks dead, isn't" family of bugs): this used to
                additionally require `!lastMessage || lastMessage.role !==
                'assistant'` -- which silently excluded EXACTLY the most
                common reattach shape: a reload/reconnect lands on a
                partial assistant message that already has some real
                content (text so far, or a finished earlier tool call)
                and then goes quiet for a long-running silent tool call.
                `pendingTurn` is confirmed true (server says the turn is
                genuinely still alive) but neither this block's old guard
                nor the inline `showThinkingIndicator` case (gated on the
                assistant message having ZERO parts) ever fired -- so the
                UI showed a static, non-growing assistant bubble with no
                spinner, no label, nothing: precisely "looks like the chat
                died" from the outside, for the one case (an already-
                started reply that goes silent) most likely to actually
                happen. Now: whenever `pendingTurn` is true and this tab
                isn't itself the one actively receiving live tokens right
                now (`chat.status !== 'streaming'` -- if it were, the
                growing text/tool card IS the liveness cue), show the
                spinner regardless of what the last message looks like. */}
            {((pendingTurn && chat.status !== 'streaming') ||
              (showThinkingIndicator && (!lastMessage || lastMessage.role !== 'assistant'))) && (
              <div className="flex justify-start flex-col items-start">
                <ThinkingIndicator label={isReconnecting ? 'Reconnecting…' : undefined} />
                {liveTurnElapsedMs != null && <LiveTurnDurationLabel elapsedMs={liveTurnElapsedMs} />}
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
          // `pendingTurn` is the durable server-side signal. Do not show
          // the voice/mic state merely because this tab's local AI SDK
          // status fell back to `ready` after a disconnect.
          streaming={isBusy}
          onAbort={chat.status === 'streaming' || chat.status === 'submitted' ? chat.stop : undefined}
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
