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
      // FIXED (2026-07-23, live prod regression within minutes of first
      // deploy: every BYOK call started failing with
      // "AI_APICallError: Cannot connect to API: invalid onError method",
      // traced to node_modules/undici/lib/core/util.js's validateHandler).
      // Root cause: Node's BUILT-IN global `fetch()` runs on its OWN
      // internal bundled copy of undici -- passing a `dispatcher` created
      // from this SEPARATELY npm-installed `undici` package through
      // RequestInit on every call mixes two different undici instances,
      // and the built-in fetch's internal request handler doesn't
      // recognize the foreign Agent correctly, corrupting the handler
      // object dispatch validates internally. `setGlobalDispatcher()` is
      // undici's own documented, correct way to install a custom
      // dispatcher for the process's global fetch across this exact
      // boundary (see undici docs, "Set Global Dispatcher") -- registering
      // it once here instead of passing `dispatcher` per-request avoids
      // the cross-instance mismatch entirely. Called immediately below,
      // at module load, so it's installed before ANY BYOK fetch ever runs.

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

/** Installs the shared pool as the process's global fetch dispatcher.
 *  This is now the ONLY correct way to apply it (see the fix note above)
 *  -- never pass the Agent as a per-request `dispatcher` RequestInit
 *  option against Node's built-in global fetch, that's the exact
 *  cross-undici-instance bug this replaced. Safe to call more than once
 *  (idempotent -- getByokDispatcher() always returns the same instance). */
export function installByokGlobalDispatcher(): void {
  setGlobalDispatcher(getByokDispatcher());
}

// Install immediately on module load -- this module is imported by
// gateway-retry-fetch.ts, which every BYOK request path already goes
// through, so requiring an extra explicit boot-time call elsewhere isn't
// necessary: importing this file at all is enough to activate it.
installByokGlobalDispatcher();
