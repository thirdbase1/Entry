/**
 * SINGLE SOURCE OF TRUTH for every timing constant in the background-
 * turn / reconnect / streaming system, plus the one shared shape used
 * for every inert "keep the wire alive" chunk in that system.
 *
 * WHY THIS FILE EXISTS (2026-07-26, "proper rework" pass): before this,
 * the numbers below lived as separate literals/consts in three different
 * files -- route.ts's writer-side heartbeat cadence, turn-lock.ts's
 * reader-side replay keep-alive cadence, and a bare `45_000` literal at
 * direct-chat-interface.tsx's `fetchWithIdleTimeout(45_000)` call site --
 * connected to each other ONLY by prose comments cross-referencing each
 * other's values (e.g. "45_000 gives 3 full heartbeat cycles of slack").
 * That's how the exact same bug got reintroduced twice in one session:
 * one file's real value moved (widening the client idle timeout from
 * 20s to 45s) while another file's comment kept citing the old "20s"
 * figure, because nothing actually enforced the relationship between
 * them -- it was pure convention, invisible to the compiler.
 *
 * The real invariant that must ALWAYS hold, by construction:
 *   REPLAY_KEEPALIVE_BLOCK_MS  <  WRITER_HEARTBEAT_MS  <  CLIENT_IDLE_TIMEOUT_MS
 * (each stage needs real headroom under the next one's watchdog, or a
 * healthy turn starts throwing false "connection dead" errors). The
 * assertion below throws at import time -- i.e. at build/boot, not
 * silently in production -- if anyone ever edits one of these values
 * without keeping the others honest.
 */

/** How often the LIVE writer stream (route.ts, actively generating a
 *  reply) races the next real chunk against a timer and, on timeout,
 *  emits a padded inert heartbeat chunk to keep the connection's bytes
 *  flowing during a long silent tool call. */
export const WRITER_HEARTBEAT_MS = 15_000;

/** How long `readTurnStream`'s XREAD BLOCK window waits for a new
 *  mirrored chunk before yielding its own padded inert keep-alive chunk
 *  on the REPLAY path (a reattaching client tailing the Redis stream,
 *  not the original live writer). Deliberately shorter than
 *  WRITER_HEARTBEAT_MS: this path has no real content of its own to
 *  fall back on while waiting, so it can afford -- and benefits from --
 *  a tighter cadence. */
export const REPLAY_KEEPALIVE_BLOCK_MS = 10_000;

/** The client transport's idle-timeout watchdog (see
 *  `fetchWithIdleTimeout`): abort a fetch if NO bytes arrive for this
 *  long. Must stay comfortably above both heartbeat cadences above --
 *  45s gives 3 full WRITER_HEARTBEAT_MS cycles and 4.5 full
 *  REPLAY_KEEPALIVE_BLOCK_MS cycles of slack, so a couple of missed/
 *  delayed heartbeats (CDN buffering, a slow tick) never falsely reads
 *  as a dead connection. */
export const CLIENT_IDLE_TIMEOUT_MS = 45_000;

/** Filler size for every padded keep-alive/heartbeat chunk in this
 *  system. Cloudflare (confirmed fronting entry.pxxl.pro via its
 *  cf-ray/cf-cache-status response headers) is known to coalesce/delay-
 *  flush very small streamed chunks rather than forwarding each one the
 *  instant it's written -- a few bytes of bare JSON sits right inside
 *  that danger zone. This costs nothing (the client ignores the extra
 *  field entirely, see `makeHeartbeatChunk` below) but makes every
 *  keep-alive chunk large enough that buffering-by-size heuristics are
 *  far less likely to sit on it. */
const HEARTBEAT_PADDING_BYTES = 2048;

/**
 * The ONE shape every heartbeat/keep-alive chunk in this system uses,
 * on both the live-writer path (route.ts) and the replay path
 * (turn-lock.ts's `readTurnStream`). Previously each path defined this
 * shape independently (identical by hand-copying, not by construction) --
 * a latent risk that a future edit to one copy's `kind` string (or the
 * client's own dedup/ignore logic keyed on it) would silently stop
 * matching the other. `type: 'custom'` is the AI SDK's own documented
 * safe no-op passthrough (see UIMessageChunk in ai/dist/index.d.ts) --
 * the client's tool/message switch only handles known types, so an
 * unrecognized `kind` here is silently ignored, never an error.
 */
export function makeHeartbeatChunk(): { type: 'custom'; kind: 'entry.heartbeat'; providerMetadata: { entry: { pad: string } } } {
  return { type: 'custom', kind: 'entry.heartbeat', providerMetadata: { entry: { pad: '0'.repeat(HEARTBEAT_PADDING_BYTES) } } };
}

// Enforce the cascade at import time -- fails the build/boot loudly
// instead of letting the values silently drift apart again.
if (!(REPLAY_KEEPALIVE_BLOCK_MS < WRITER_HEARTBEAT_MS && WRITER_HEARTBEAT_MS < CLIENT_IDLE_TIMEOUT_MS)) {
  throw new Error(
    `[direct-chat/timing] broken keep-alive cascade: REPLAY_KEEPALIVE_BLOCK_MS(${REPLAY_KEEPALIVE_BLOCK_MS}) must be < WRITER_HEARTBEAT_MS(${WRITER_HEARTBEAT_MS}) must be < CLIENT_IDLE_TIMEOUT_MS(${CLIENT_IDLE_TIMEOUT_MS})`
  );
}
