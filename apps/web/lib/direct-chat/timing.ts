/**
 * SINGLE SOURCE OF TRUTH for the two timing constants left in the
 * direct-chat streaming system, plus the one shared shape used for every
 * inert "keep the wire alive" chunk in that system.
 *
 * HISTORY (2026-07-26 "proper rework" pass, then 2026-08-07 workflow
 * migration): this file originally coordinated THREE cadences across
 * three files -- the old route.ts's writer-side heartbeat, turn-lock.ts's
 * separate reader-side replay keep-alive (for a client tailing a Redis
 * mirror), and direct-chat-interface.tsx's client idle-timeout watchdog.
 * The migration to Vercel Workflow SDK (see turn-workflow.ts's file
 * header) retired turn-lock.ts and its Redis mirror outright -- a
 * reattaching/reconnecting client (WorkflowChatTransport, or the
 * [chatId]/stream GET route) now reads from the exact same underlying
 * workflow run stream the writer populates, so it automatically inherits
 * whatever the writer already wrote, heartbeats included. There is no
 * more separate reader-side replay path with its own silence to plug --
 * REPLAY_KEEPALIVE_BLOCK_MS is gone. Only two cadences remain:
 *
 * The real invariant that must ALWAYS hold, by construction:
 *   WRITER_HEARTBEAT_MS  <  CLIENT_IDLE_TIMEOUT_MS
 * (the writer needs real headroom under the client's watchdog, or a
 * healthy turn starts throwing false "connection dead" errors). The
 * assertion below throws at import time -- i.e. at build/boot, not
 * silently in production -- if anyone ever edits one of these values
 * without keeping the other honest.
 *
 * WRITER_HEARTBEAT_MS is reinstated in turn-workflow.ts's leg-forwarding
 * loop (2026-08-07): workflow durability answers "does the server keep
 * working across a dropped connection", a completely different question
 * from "does an intermediate proxy/carrier gateway kill an HTTP
 * connection after N seconds of raw byte silence" -- the exact,
 * previously-incident-confirmed failure mode below ("agent stops at 1
 * min but runs for 21 min") is just as possible during a long silent
 * tool call regardless of which orchestration layer sits behind it.
 *
 * OPTIMIZED (2026-07-27, "maximize responsiveness, prevent drops, ultra-fast recovery"):
 * The previous cascade (10s / 15s / 45s) was too slow and caused connections to drop on proxies
 * or carrier gateways that time out after 10-15s of silence. The subsequent tightened cascade
 * (5s / 8s / 25s) was better but still left 8s gaps and took 25s to recover.
 * We have mathematically optimized the cascade to (5s / 16s):
 *   - Writer heartbeat every 5s — keeps the wire warm with frequent bytes, safely
 *     below any aggressive 10-15s proxy/carrier timeouts.
 *   - Client idle timeout 16s — provides 3.2x writer heartbeat cycles of slack (tolerates
 *     up to 3 missed heartbeats with 1s network/client jitter buffer) while allowing dead connections
 *     to be detected and recovered in just 16s.
 * Overhead at 5s heartbeat with 8KB padding: ~1.6KB/s — negligible for modern network connections.
 */

/** How often the leg-forwarding loop (turn-workflow.ts) races the next
 *  real chunk against a timer and, on timeout, writes a padded inert
 *  heartbeat chunk to keep the connection's bytes flowing during a long
 *  silent tool call. */
export const WRITER_HEARTBEAT_MS = 5_000;

/** The client transport's idle-timeout watchdog (see
 *  `fetchWithIdleTimeout`): abort a fetch if NO bytes arrive for this
 *  long. Must stay comfortably above the heartbeat cadence above -- 16s
 *  gives 3.2 full WRITER_HEARTBEAT_MS cycles of slack, so a couple of
 *  missed/delayed heartbeats (CDN buffering, a slow tick) never falsely
 *  read as a dead connection — but a genuinely dead connection is
 *  detected and recovered in just 16s. */
export const CLIENT_IDLE_TIMEOUT_MS = 16_000;

/** Filler size for every padded keep-alive/heartbeat chunk in this
 *  system. Cloudflare (confirmed fronting entry.pxxl.pro via its
 *  cf-ray/cf-cache-status response headers) is known to coalesce/delay-
 *  flush very small streamed chunks rather than forwarding each one the
 *  instant it's written -- a few bytes of bare JSON sits right inside
 *  that danger zone. This costs nothing (the client ignores the extra
 *  field entirely, see `makeHeartbeatChunk` below) but makes every
 *  keep-alive chunk large enough that buffering-by-size heuristics are
 *  far less likely to sit on it. */
// INCREASED (2026-07-27, "agent stops at 1 min but runs for 21 min"):
// 2KB was not enough to defeat Cloudflare/pxxl proxy buffering — the
// proxy coalesced heartbeat chunks and the client never saw them,
// causing false idle-timeout aborts after ~1 min of silent tool calls.
// 8KB is large enough that virtually no proxy can justify buffering it.
const HEARTBEAT_PADDING_BYTES = 8192;

/**
 * The ONE shape every heartbeat/keep-alive chunk in this system uses.
 * `type: 'custom'` is the AI SDK's own documented safe no-op passthrough
 * (see UIMessageChunk in ai/dist/index.d.ts) -- the client's tool/message
 * switch only handles known types, so an unrecognized `kind` here is
 * silently ignored, never an error.
 */
export function makeHeartbeatChunk(): { type: 'custom'; kind: 'entry.heartbeat'; providerMetadata: { entry: { pad: string } } } {
  return { type: 'custom', kind: 'entry.heartbeat', providerMetadata: { entry: { pad: '0'.repeat(HEARTBEAT_PADDING_BYTES) } } };
}

// Enforce the cascade at import time -- fails the build/boot loudly
// instead of letting the values silently drift apart again.
if (!(WRITER_HEARTBEAT_MS < CLIENT_IDLE_TIMEOUT_MS)) {
  throw new Error(
    `[direct-chat/timing] broken keep-alive cascade: WRITER_HEARTBEAT_MS(${WRITER_HEARTBEAT_MS}) must be < CLIENT_IDLE_TIMEOUT_MS(${CLIENT_IDLE_TIMEOUT_MS})`
  );
}
