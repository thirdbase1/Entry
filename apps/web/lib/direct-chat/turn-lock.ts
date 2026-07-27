/**
 * Per-chat turn coordination, backed by Upstash Redis (via @entry/cache).
 *
 * ADDED (2026-07-25, explicit user report: "if a task is working in
 * background I can still send multiple prompts and I get multiple
 * responses, so it's confusing"). Root cause, confirmed directly against
 * route.ts: nothing anywhere ever checked whether a turn for a given
 * chatId was already in flight before starting a brand new streamText()
 * call for that same chatId -- two concurrent POSTs (a real double-send,
 * or a reload that re-fires while the original turn is still running)
 * simply ran two independent model turns in parallel against the same
 * chat row, both eventually writing their own reply, which is exactly
 * the "two responses to one message, confusing" symptom.
 *
 * Two things live here:
 *
 * 1. A short-TTL, heartbeat-renewed lock (`turn:lock:{chatId}`) that
 *    route.ts must acquire (atomic SET NX) before starting any turn, and
 *    release when the turn ends. A second POST for the same chat while
 *    the lock is held gets rejected immediately (409) instead of ever
 *    calling the model -- see route.ts's own use of this.
 *
 * 2. A Redis Stream mirror (`turn:stream:{chatId}`) of every raw
 *    UIMessageChunk the in-flight turn emits, in order. This is what
 *    lets a RELOADED page (or a second tab/device) re-attach to a turn
 *    that's still running and see the rest of it stream in live instead
 *    of only finding out once it's fully done via a DB poll -- see the
 *    new [chatId]/stream/route.ts GET endpoint, which is the server side
 *    of the AI SDK's built-in `useChat({ resume: true })` reconnect
 *    protocol (confirmed directly against node_modules/ai's
 *    `reconnectToStream`: it GETs `{api}/{chatId}/stream` expecting
 *    either 204 (nothing to resume) or a normal UI-message-stream body).
 *
 * TTL/heartbeat model: the lock's real TTL is short (LOCK_TTL_MS) so an
 * orphaned lock (a code path that somehow skips the explicit release)
 * self-heals fast, but a genuinely-still-running turn renews it well
 * before expiry via `startTurnHeartbeat` -- so "still working" never
 * looks abandoned as long as the heartbeat interval is alive, which it
 * is for as long as the turn's own async work is alive, independent of
 * whether the ORIGINAL client is still connected (same "survives a
 * dropped connection" guarantee route.ts's `consumeStream()` already
 * gives the model call itself -- this just extends the same guarantee to
 * the lock/mirror bookkeeping).
 */
import { cache, getRawRedis } from '@entry/cache';
import { REPLAY_KEEPALIVE_BLOCK_MS, makeHeartbeatChunk } from './timing';

const LOCK_TTL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = Math.floor(LOCK_TTL_MS / 2);
const STREAM_TTL_SECONDS = 600;

function lockKey(chatId: string): string {
  return `entry:turn:lock:${chatId}`;
}
function streamKey(chatId: string): string {
  return `entry:turn:stream:${chatId}`;
}

export const TURN_END_MARKER = '__entry_turn_end__';

export async function acquireTurnLock(chatId: string, turnId: string): Promise<boolean> {
  return cache.setnx(lockKey(chatId), turnId, { ttl: LOCK_TTL_MS });
}

export async function getActiveTurnId(chatId: string): Promise<string | null> {
  const v = await cache.get<string>(lockKey(chatId));
  return v ?? null;
}

const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

async function renewTurnLock(chatId: string, turnId: string): Promise<boolean> {
  try {
    const res = await getRawRedis().eval(RENEW_SCRIPT, 1, lockKey(chatId), turnId, String(LOCK_TTL_MS));
    return res === 1;
  } catch (err) {
    console.error('[turn-lock] renew failed', chatId, err);
    return false;
  }
}

export async function releaseTurnLock(chatId: string, turnId: string): Promise<void> {
  try {
    await getRawRedis().eval(RELEASE_SCRIPT, 1, lockKey(chatId), turnId);
  } catch (err) {
    console.error('[turn-lock] release failed', chatId, err);
  }
}

// Safety-net ceiling: if some exception path in route.ts ever fails to
// call the returned stop-function (a throw between lock-acquire and
// wrappedStream that isn't individually caught -- this file can't see
// every one of route.ts's exit paths, and re-auditing all of them every
// time that function changes is fragile), this bounds the damage to "the
// heartbeat interval leaks for at most this long", not forever. A real
// still-running turn heartbeats every HEARTBEAT_INTERVAL_MS well inside
// this window and is never affected by it.
const MAX_HEARTBEAT_MS = 25 * 60 * 1000;

export function startTurnHeartbeat(chatId: string, turnId: string): () => void {
  const interval = setInterval(() => {
    void renewTurnLock(chatId, turnId);
  }, HEARTBEAT_INTERVAL_MS);
  const maxTimer = setTimeout(() => clearInterval(interval), MAX_HEARTBEAT_MS);
  return () => {
    clearInterval(interval);
    clearTimeout(maxTimer);
  };
}

// SAFETY-NET TTL (2026-07-26, real leak found while auditing this exact
// file's own "safety-net ceiling" philosophy -- see MAX_HEARTBEAT_MS
// above -- and noticing it wasn't applied here too): before this, the
// stream key got NO ttl at all until publishTurnEnd() ran and set one.
// That's fine for every NORMAL exit path (route.ts's endTurn() funnels
// everything there), but a truly abnormal one -- the Node process itself
// dying mid-turn (OOM, SIGKILL, host-level restart) -- skips every JS
// finally/catch in the process, so publishTurnEnd() never runs and the
// stream key would sit in Redis with no expiry, forever, on THIS
// persistent long-lived process, one leaked key per crashed turn for the
// life of the deployment. Renewed on every chunk (self-heals during a
// real long turn the same way the lock's own heartbeat does), generous
// enough to never race a legitimate long turn, but bounded -- a crashed
// turn's stream is now reclaimed within this window instead of never.
const STREAM_SAFETY_NET_TTL_SECONDS = 30 * 60; // 30m, comfortably above MAX_HEARTBEAT_MS (25m)

// CROSS-TURN STREAM BLEED FIX (2026-07-27, real bug, owner report:
// "it's showing previous model response [after] reconnect sync poll" --
// confirmed by reading this file's stream key scheme end to end, not
// assumed. `streamKey(chatId)` is keyed by chatId ONLY -- every turn for
// the same chat appends to the exact SAME Redis Stream, forever (only a
// rolling TTL, never a clear/trim on a NEW turn starting). `readTurnStream`
// has no per-turn filter either: it yields every entry in stream order
// and stops at the FIRST end-marker it finds. So the SECOND (or any
// later) message in a chat starts a reconnect scan from lastId='0' (no
// watermark yet for the brand-new turnId) straight into a stream that
// still holds turn #1's entire already-finished reply + end-marker --
// any reconnect mid-turn-#2-or-later (the periodic recovery poll, a
// mount-time resumeStream(), a dropped connection) replays turn #1's old
// content and then STOPS at turn #1's own end-marker, never reaching the
// actual current turn's chunks at all. Exactly "previous model's
// response" reappearing on reconnect.
//
// FIX: wipe the stream key the moment a NEW turn actually starts (right
// after this exact turnId's lock is freshly acquired in route.ts, before
// any chunk for it is published) so each turn's mirror always starts
// empty. Belt-and-suspenders: readTurnStream below also now skips any
// entry whose tagged turnId doesn't match the turnId it was asked to
// replay, so even a reset that racingly loses to an in-flight publish
// from the tail end of a just-finished prior turn can never leak into a
// new one's reconnect.
export async function resetTurnStream(chatId: string): Promise<void> {
  try {
    await getRawRedis().del(streamKey(chatId));
  } catch (err) {
    console.error('[turn-stream] reset failed', chatId, err);
  }
}

export async function publishTurnChunk(chatId: string, turnId: string, chunk: unknown): Promise<void> {
  try {
    // NO MAXLEN TRIM (2026-07-26, real correctness gap found while
    // auditing the reconnect path: this used to pass `MAXLEN ~
    // STREAM_MAXLEN`, Redis's APPROXIMATE trim mode, on every single
    // write DURING an active turn. A long, chatty turn (heavy tool use,
    // lots of small text-deltas) approaching that count could have its
    // OWN earliest chunks evicted before a from-scratch reconnect
    // (readTurnStream starting at lastId='0') ever got to replay them --
    // silent, undetectable data loss on the one path that exists
    // specifically to make reconnects whole again. There's no unbounded-
    // growth risk being traded away here to justify that: this stream is
    // scoped to a single turn and already gets a hard TTL
    // (STREAM_TTL_SECONDS) the moment the turn ends via publishTurnEnd
    // below -- correctness during the live turn matters far more than
    // trimming a stream that's about to be TTL'd away anyway.
    const redis = getRawRedis();
    await redis.xadd(streamKey(chatId), '*', 'turnId', turnId, 'data', JSON.stringify(chunk));
    // Fire-and-forget: never let a slow/failed EXPIRE delay or break the
    // actual chunk publish it's riding along with.
    void redis.expire(streamKey(chatId), STREAM_SAFETY_NET_TTL_SECONDS).catch(() => {});
  } catch (err) {
    console.error('[turn-stream] publish failed', chatId, err);
  }
}

export async function publishTurnEnd(chatId: string, turnId: string): Promise<void> {
  try {
    const redis = getRawRedis();
    await redis.xadd(streamKey(chatId), '*', 'turnId', turnId, 'data', JSON.stringify({ type: TURN_END_MARKER }));
    await redis.expire(streamKey(chatId), STREAM_TTL_SECONDS);
  } catch (err) {
    console.error('[turn-stream] publish-end failed', chatId, err);
  }
}

// DUPLICATE-CONTENT FIX (2026-07-27, real user report + screen
// recording, THIRD time this exact symptom was reported: an already-
// finished paragraph of an assistant reply visibly repeating itself over
// and over, growing for ~30s, on a single continuously-open tab with a
// visibly flaky mobile connection -- no reload, no second tab). Root
// cause, confirmed by reading this file + direct-chat-interface.tsx's
// onError handler together (not assumed): `readTurnStream` always
// started `lastId` at Redis's `'0'`, i.e. EVERY single call replayed the
// turn's ENTIRE mirrored chunk history from the very beginning, no
// matter how many times it's called. But `readTurnStream` is ONLY ever
// invoked by the GET `/stream` reattach route -- the original live turn
// (route.ts's own POST response) enqueues chunks to its OWN controller
// directly and never calls this function at all (confirmed: its only
// interaction with turn-lock.ts is the fire-and-forget `publishTurnChunk`
// mirror write). So every call to this generator is inherently a
// RECONNECT. On a flaky connection, `direct-chat-interface.tsx`'s onError
// handler retries `chat.resumeStream()` up to 4 times with backoff
// (`[0, 1000, 3000, 6000]`) PER hiccup, and `resume: true` also fires it
// once on every mount -- and the SAME tab, having never reloaded, already
// holds 100% of everything generated so far in `chat.messages`. Every one
// of those resumeStream() calls re-streamed the FULL history from '0'
// straight into that same already-populated message via ordinary
// 'text-delta' chunks (which are pure-append by protocol, there is no
// "replace" semantic per chunk) -- each reconnect attempt stacked another
// full duplicate copy of everything generated so far on top of the
// message, worse the flakier the connection (matches the video exactly:
// multiple duplicate copies appearing within one continuous ~30s
// recording, correlating with visibly dropping network throughput).
//
// FIX: track, per chatId+turnId, the highest stream entry id any PRIOR
// reconnect for this exact still-active turn has already delivered
// (module-level Map -- same "persistent long-lived Pxxl process" pattern
// already used by provider-cooldown.ts's cooldown map and this file's own
// lock/heartbeat state). The FIRST reconnect for a turn still legitimately
// replays from '0' (a reload landing very early, before any incremental DB
// save has landed, must not silently lose the whole response) -- every
// SUBSEQUENT reconnect for that SAME turn resumes exactly where the
// previous one left off instead of re-replaying what's already been sent,
// closing off the duplication at its actual source. Cleared the moment
// the turn ends (TURN_END_MARKER) so it can never leak across turns or
// grow unbounded.
const turnReplayWatermark = new Map<string, string>();
function watermarkKey(chatId: string, turnId: string): string {
  return `${chatId}:${turnId}`;
}

// TERMINAL-REPLAY FIX (2026-07-27, real user report + video, FOURTH time
// this exact symptom was reported despite the watermark fix directly
// above -- confirmed by re-reading that fix's own logic end to end: it
// DELETES the watermark the moment TURN_END_MARKER is seen. That's the
// remaining hole. The outer GET /stream route's ONLY gate on whether to
// call this generator at all is `getActiveTurnId(chatId) !== null` (the
// Redis turn-LOCK) -- and that lock can keep reading "active" for a
// while after the turn has already fully finished and its
// TURN_END_MARKER already been delivered once (lock TTL is 30s and only
// self-heals on its own schedule; it does not get released early just
// because a reconnect happened to observe the end marker). Any reconnect
// that lands in that stale-but-still-locked window -- the periodic
// recovery poll firing every couple seconds while `active` still reads
// true is exactly this shape -- finds the watermark GONE (already
// deleted the first time the marker was seen) and falls back to
// `lastId = '0'`, i.e. replays the turn's ENTIRE content from scratch
// AGAIN before hitting the end marker a second time. Every such stale
// reconnect reproduces one full duplicate copy of the whole reply --
// exactly the repeating-duplicate-bubble pattern, recurring for as long
// as the lock stays stale (which is unbounded if something also keeps
// the lock from ever being released -- see turn-status's own DB-wins
// fallback on the client for the matching defense-in-depth half of this
// same bug).
//
// FIX: once a turn's end marker has genuinely been delivered to ANY
// caller, remember that permanently (module-level Set, same "persistent
// long-lived Pxxl process" pattern already used everywhere else in this
// file) instead of just deleting the watermark. Any FURTHER call for
// that exact turnId short-circuits to "nothing left, ever" -- zero
// re-reads of the stream, zero duplicate content -- no matter how many
// more times a stale lock lets a reconnect through. Cleared naturally
// with the rest of this process's memory on redeploy/restart; unbounded
// growth isn't a real risk here since finished turns stop accumulating
// once their chatId's next NEW turn starts (a fresh turnId), and a
// single process only ever holds as many entries as turns it has
// personally finished serving.
const finishedTurnIds = new Set<string>();
export function hasTurnStreamEnded(chatId: string, turnId: string): boolean {
  return finishedTurnIds.has(watermarkKey(chatId, turnId));
}

export async function* readTurnStream(
  chatId: string,
  signal: AbortSignal
): AsyncGenerator<{ chunk: unknown; turnId: string }> {
  const redis = getRawRedis().duplicate();
  const key = streamKey(chatId);
  // Snapshot the turnId this call is actually meant to replay ONCE, up
  // front -- see the cross-turn stream bleed fix's header comment above.
  // Any entry belonging to a DIFFERENT turnId (a straggler from a prior
  // turn that hadn't been cleared/reset yet) is simply skipped, never
  // yielded and never treated as this turn's own end-marker.
  const targetTurnId = await getActiveTurnId(chatId);
  // Best-effort turnId for the watermark lookup: acquireTurnLock/
  // getActiveTurnId already scope one turnId per active lock, so read it
  // once up front -- if it's ever unavailable (lock just expired between
  // the route's own getActiveTurnId check and here), '0' is still the
  // safe fallback (equivalent to today's always-full-replay behavior for
  // that edge case only).
  const activeTurnId = await getActiveTurnId(chatId);
  // Short-circuit BEFORE ever touching Redis's xread: if this exact turn
  // already delivered its end marker to a prior caller, there is
  // permanently nothing left to replay for it, full stop -- see
  // `finishedTurnIds`'s own comment above for why the watermark alone
  // isn't enough to guarantee this on every path.
  if (activeTurnId && hasTurnStreamEnded(chatId, activeTurnId)) return;
  let lastId = (activeTurnId && turnReplayWatermark.get(watermarkKey(chatId, activeTurnId))) || '0';
  const onAbort = () => {
    redis.disconnect();
  };
  signal.addEventListener('abort', onAbort);
  try {
    while (!signal.aborted) {
      let res: [string, [string, string[]][]][] | null = null;
      try {
        res = (await redis.xread('COUNT', 500, 'BLOCK', REPLAY_KEEPALIVE_BLOCK_MS, 'STREAMS', key, lastId)) as any;
      } catch (err) {
        if (signal.aborted) return;
        console.error('[turn-stream] xread failed', chatId, err);
        return;
      }
      if (!res) {
        // KEEP-ALIVE FIX (2026-07-26, real user report: a turn that
        // genuinely ran ~20min server-side -- confirmed complete and
        // correct in the DB the whole time -- still showed a "Couldn't
        // reach the server" banner on the reattached tab). Root cause:
        // XREAD's BLOCK window here (10s) can come back empty over and
        // over during a real, healthy silent gap -- a long-running tool
        // call (bash, a build, anything) easily goes well past the
        // client's idle watchdog (see fetchWithIdleTimeout) with zero new
        // stream chunks to mirror, since there's genuinely nothing new to
        // report yet. Previously this branch was a bare `continue`,
        // meaning literally zero bytes reached the client for the entire
        // gap, tripping the watchdog and surfacing a scary false-alarm
        // error banner for a turn that was never actually stuck at all.
        //
        // PADDED (2026-07-26, same pass as the MAXLEN fix above): this
        // used to yield a bare `{ type: 'message-metadata' }` -- a handful
        // of bytes. That's the EXACT shape Cloudflare (confirmed fronting
        // entry.pxxl.pro, see route.ts's own heartbeat comment) is known
        // to coalesce/delay-flush rather than forward immediately, which
        // would silently defeat this keep-alive's entire purpose on the
        // reattach path specifically. Reusing the SAME already-proven,
        // already-padded `type: 'custom'` / `entry.heartbeat` shape the
        // primary stream's own heartbeat uses (see route.ts) both closes
        // that gap and keeps exactly one keep-alive shape for the client
        // to ever have to silently ignore, instead of two.
        yield { chunk: makeHeartbeatChunk(), turnId: '' };
        continue;
      }
      const [, entries] = res[0];
      for (const [id, fields] of entries) {
        lastId = id;
        const dataIdx = fields.indexOf('data');
        const turnIdIdx = fields.indexOf('turnId');
        const raw = dataIdx >= 0 ? fields[dataIdx + 1] : undefined;
        const turnId = turnIdIdx >= 0 ? fields[turnIdIdx + 1] : '';
        if (!raw) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        // Record the watermark for whichever turnId this chunk actually
        // belongs to BEFORE yielding -- if the consumer (the HTTP
        // controller) throws partway through forwarding this batch, the
        // worst case is a future reconnect re-sends a few already-seen
        // chunks (harmless -- isSafeToAdopt/the DB poll already tolerate
        // that), never that it skips content that never made it out.
        if (targetTurnId && turnId && turnId !== targetTurnId) {
          // Stale entry from a different (older, or -- in a race -- even
          // a not-yet-started newer) turn on this same chatId's shared
          // stream key: never yield it, never let it satisfy this call's
          // end-marker check.
          continue;
        }
        if (turnId) turnReplayWatermark.set(watermarkKey(chatId, turnId), id);
        if ((parsed as { type?: string })?.type === TURN_END_MARKER) {
          if (turnId) {
            finishedTurnIds.add(watermarkKey(chatId, turnId));
            turnReplayWatermark.delete(watermarkKey(chatId, turnId));
          }
          return;
        }
        yield { chunk: parsed, turnId };
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    redis.quit().catch(() => redis.disconnect());
  }
}
