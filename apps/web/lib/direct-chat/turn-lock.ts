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
    await getRawRedis().xadd(streamKey(chatId), '*', 'turnId', turnId, 'data', JSON.stringify(chunk));
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

export async function* readTurnStream(
  chatId: string,
  signal: AbortSignal
): AsyncGenerator<{ chunk: unknown; turnId: string }> {
  const redis = getRawRedis().duplicate();
  const key = streamKey(chatId);
  let lastId = '0';
  const onAbort = () => {
    redis.disconnect();
  };
  signal.addEventListener('abort', onAbort);
  try {
    while (!signal.aborted) {
      let res: [string, [string, string[]][]][] | null = null;
      try {
        res = (await redis.xread('COUNT', 500, 'BLOCK', 10_000, 'STREAMS', key, lastId)) as any;
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
        yield {
          chunk: { type: 'custom', kind: 'entry.heartbeat', providerMetadata: { entry: { pad: '0'.repeat(2048) } } },
          turnId: '',
        };
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
        if ((parsed as { type?: string })?.type === TURN_END_MARKER) return;
        yield { chunk: parsed, turnId };
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    redis.quit().catch(() => redis.disconnect());
  }
}
