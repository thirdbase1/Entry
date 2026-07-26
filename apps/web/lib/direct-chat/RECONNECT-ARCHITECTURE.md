# Background turns, reconnect, and streaming — how this actually works

This is the one place to read to understand the whole system end to end.
Everywhere else (route.ts, turn-lock.ts, direct-chat-interface.tsx) still
carries its own dated, bug-specific comments explaining *why* a given line
exists — keep those, they're the incident history. This doc is the
current, coherent mental model instead of having to reconstruct it from
those comments one bug at a time.

## The core guarantee

Once a turn's POST reaches the server, it keeps running to completion
server-side **no matter what happens to the client** — a reload, a lost
connection, a backgrounded tab, a lost network with no clean
`offline`/`online` transition, all of it. Nothing about the client's
connection state ever stops the actual model/tool work. Everything below
exists to make the *client* accurately reflect that reality — never to
let a live turn slip through, and never to leave the UI showing "idle"
or "dead" while real work is still happening.

## The four pieces

**1. Turn lock** (`turn-lock.ts`, Redis-backed)
One turn per chat at a time. `acquireTurnLock` / `startTurnHeartbeat`
(renews every `LOCK_TTL_MS / 2`) / `releaseTurnLock`. A second POST for
the same chat while a turn is active gets rejected — this is what
prevents "I sent two messages and got two confusing overlapping replies."

**2. Chunk mirror + replay** (`turn-lock.ts`: `publishTurnChunk`,
`readTurnStream`)
Every chunk the live writer emits is *also* fire-and-forget mirrored into
a per-chat Redis Stream. `readTurnStream` tails that stream from
`lastId='0'` (or wherever a specific reattach left off) — this is what
lets a reloaded/reconnected tab replay everything it missed, including
mid-turn, without needing the *original* connection to still exist.
Never trim this stream mid-turn (see the no-MAXLEN comment in
`publishTurnChunk` — a trim during a live turn can silently drop the
earliest chunks before a from-scratch reconnect ever reads them). It's
naturally bounded anyway: real TTL kicks in the moment the turn ends.

**3. Keep-alives** (`timing.ts` is the source of truth for all of this)
Two independent keep-alive loops, at different cadences, for different
reasons:
  - The **live writer** (route.ts) races the next real chunk against
    `WRITER_HEARTBEAT_MS` and emits a padded inert chunk on timeout, so a
    long silent tool call (bash, browser_use, a slow search) never lets
    the wire go quiet long enough for a proxy/CDN/carrier gateway to
    decide the connection is dead.
  - The **replay reader** (`readTurnStream`) does the same thing
    independently, every `REPLAY_KEEPALIVE_BLOCK_MS`, for a *reattaching*
    client tailing the mirror — it can't rely on the writer's heartbeats
    alone reaching it (they're a separate stream, mirrored as regular
    content chunks, and a long empty XREAD BLOCK window needs its own
    keep-alive regardless).
  Both use the exact same `makeHeartbeatChunk()` shape (padded, so CDN
  edges that coalesce small chunks don't swallow it) — one function,
  used by both, so they can never drift into two different shapes.
  The client's own idle-timeout watchdog (`fetchWithIdleTimeout`, wired
  with `CLIENT_IDLE_TIMEOUT_MS`) sits strictly above both cadences. This
  cascade — `REPLAY_KEEPALIVE_BLOCK_MS < WRITER_HEARTBEAT_MS <
  CLIENT_IDLE_TIMEOUT_MS` — is asserted at import time in `timing.ts`,
  not just documented, specifically because it silently broke twice
  before that assertion existed.

**4. Client-side turn lifecycle** (`direct-chat-interface.tsx`)
One `useReducer` (`turnLifecycleReducer`) owns exactly two pieces of
state: `pendingTurn` (is a turn genuinely active *somewhere*, whether or
not this tab is the one streaming it) and `turnError` (a real, current
error worth showing). Every transition is a named action —
`SET_PENDING`, `SET_ERROR`, `CLEAR_ERROR`, `RECONNECT_PROGRESS`,
`RECONNECT_GAVE_UP` — dispatched from exactly 4 places: `onFinish`,
`onError`, `onSend`, and the recovery-poll effect (`tryRecover`). Before
2026-07-26 this was two separate `useState`s plus two staleness-mirror
refs, mutated ad hoc from those same 4 places — every single bug found
in this file traced back to one of those calls being missed in one
specific branch. The reducer doesn't eliminate that risk category by
magic, but it does make every valid transition visible in one function
instead of requiring a full-file read to enumerate them.

`tryRecover` (the recovery-poll effect) is the piece doing the real
work of staying honest with the server:
  - Self-reschedules on a variable cadence (800ms while "still catching
    up", 3s once settled) rather than a fixed interval, so a reload
    landing mid-turn reads as a near-continuous catch-up instead of one
    big jump.
  - Also fires on `online`/`visibilitychange`/`focus`, since some
    network drops/restores never fire a clean browser event at all.
  - Reconciles against `/api/chats/:id` (the DB) whenever *not* actively,
    healthily streaming locally — content-level diff, not just a length
    check, so a message that only grew via appended parts is still
    caught.
  - Before ever declaring "settled" (pendingTurn → false) off wall-clock
    quiet time alone, asks the one place that actually knows —
    `/api/direct/chat/:id/turn-status` (the Redis lock) — since a long
    silent tool call can legitimately produce zero DB growth for minutes
    while still very much alive.
  - The moment that status check confirms the turn is alive, it doesn't
    just flip a flag and wait for the next poll — it actively calls
    `chat.resumeStream()` right then (with retry+backoff on the reattach
    itself, since a flaky reconnect attempt isn't the same as a dead
    turn) so real tokens start appearing immediately instead of the tab
    sitting there "busy" with nothing visibly happening.
  - Only gives up for good (`RECONNECT_GAVE_UP`, stops rescheduling
    itself) after 8 consecutive real `404`s from the DB endpoint — i.e.
    a chat that provably never got created server-side at all (the
    initiating POST itself never landed). A transient network error on
    the poll itself does NOT trip this; it's caught, logged, and the
    self-reschedule loop just tries again next tick regardless.

## The UI-feedback rule

`pendingTurn && chat.status !== 'streaming'` is the one condition that
means "show the user something is happening, even though nothing local
is visibly growing right now." It does not care what the last message
looks like — empty, mid-user-turn, or a partial assistant reply that's
gone quiet on a long tool call are all the same case from the UI's
perspective: real work confirmed alive, nothing local to show it, so
show the spinner. Getting this condition too narrow (gating it on the
last message's role/content, as it used to be) is exactly how "reload
during a long silent tool call looks dead" bugs happen — the server-
confirmed truth and the on-screen state silently disagree.

## If you're about to touch this system

1. All new timing constants belong in `timing.ts`, not as bare literals.
   If a new value needs to stay ahead of/behind an existing one, add it
   to the import-time assertion — don't just leave a comment.
2. If you're adding a new state flag to the client turn lifecycle, ask
   first whether it actually belongs in `turnLifecycleReducer` instead
   of a new independent `useState`/ref pair. That's precisely the
   pattern that caused every bug fixed here.
3. Never trim/expire the Redis mirror stream *during* an active turn.
   TTL-after-`publishTurnEnd` is the only cleanup that's safe.
4. A "give up" path that stops a self-rescheduling loop needs to be
   scoped to a provably terminal condition (a real 404 on a chat that
   was never created), never to a generic catch — a generic network
   catch should always let the loop keep retrying.
