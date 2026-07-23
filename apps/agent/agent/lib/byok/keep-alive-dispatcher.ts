/**
 * Shared, tuned undici connection pool for ALL BYOK provider traffic.
 *
 * ROOT CAUSE (2026-07-23, user-reported "connection to BYOK endpoint is
 * so slow"): every BYOK request previously went through Node's default
 * global fetch dispatcher, whose undici defaults are:
 *   - `keepAliveTimeout: 4_000ms` -- a pooled TCP+TLS socket to a given
 *     BYOK origin is torn down if idle for more than 4 seconds.
 *   - `connections: 10` per origin (fine, rarely the bottleneck).
 *
 * A single chat turn routinely has multi-second gaps between requests to
 * the SAME BYOK origin -- a tool call (sandbox exec, browser automation,
 * file read) frequently takes well over 4s to finish before the next
 * message goes back to the model. With the 4s default, that next request
 * always pays for a brand new TCP handshake + full TLS negotiation
 * against the user's origin, which is often itself a multi-hop relay
 * (see gateway-retry-fetch.ts's iamhc.cn investigation) -- i.e. the
 * exact "every single follow-up call feels slow to establish" symptom.
 *
 * Fix: one shared undici `Agent` (a real per-origin connection pool),
 * with keep-alive intentionally stretched far past normal tool-call
 * gaps, so a BYOK origin's socket survives the whole turn instead of
 * getting rebuilt from scratch after almost every tool call.
 */
import { Agent, setGlobalDispatcher } from 'undici';

let sharedAgent: Agent | undefined;

export function getByokDispatcher(): Agent {
  if (!sharedAgent) {
    sharedAgent = new Agent({
      // Keep pooled sockets alive across normal tool-call gaps (previously
      // 4s default -- bumped to 2 minutes, comfortably longer than any
      // single tool execution most turns hit).
      keepAliveTimeout: 120_000,
      // Absolute cap a socket is ever kept, regardless of traffic --
      // avoids holding a socket open indefinitely if a relay's own LB
      // expects periodic rotation.
      keepAliveMaxTimeout: 600_000,
      // Enough concurrent sockets per BYOK origin for several parallel
      // chats/tool calls without queuing on the connection pool itself.
      connections: 32,
      // Fail a truly dead/unreachable relay fast instead of hanging --
      // this is a TCP-connect timeout, unrelated to how long a real
      // (possibly long, streaming) response is allowed to take.
      connect: { timeout: 10_000 },
    });
  }
  return sharedAgent;
}

/** Installed once at process boot (see agent.ts) so ANY fetch call in the
 *  process -- not just ones that remember to pass `dispatcher` explicitly
 *  -- gets the tuned pool by default. Individual BYOK fetch wrappers still
 *  pass it explicitly too, belt-and-suspenders, in case some other part of
 *  the process ever installs a different global dispatcher later. */
export function installByokGlobalDispatcher(): void {
  setGlobalDispatcher(getByokDispatcher());
}

// FIXED (2026-07-23): install eagerly at module load. Passing the Agent as
// a per-request `dispatcher` RequestInit option (the previous pattern in
// gateway-retry-fetch.ts) mixes this separately-installed undici package's
// Agent with Node's own internal bundled undici instance behind the
// built-in global fetch, and broke production within minutes of first
// deploy (AI_APICallError: "Cannot connect to API: invalid onError
// method", traced to undici/lib/core/util.js's validateHandler -- see
// apps/web's identical file for the full root-cause writeup). Global
// installation is undici's own documented-correct pattern for this exact
// boundary and avoids the cross-instance mismatch entirely.
installByokGlobalDispatcher();
