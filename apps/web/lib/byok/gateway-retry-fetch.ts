/**
 * Custom `fetch` wrapper for OpenAI-compatible BYOK providers, retrying
 * transient failures from a multi-node relay (iamhc.cn, several real user
 * reports 2026-07-11 through 2026-07-15) rather than letting the SDK's
 * default classifier treat them as permanent.
 *
 * Root cause (confirmed 2026-07-15 by capturing the actual raw
 * `requestBodyValues`/`responseBody` off a live failing multi-step BYOK
 * turn -- see admin/diag-toolcall route): this relay is a multi-node
 * load-balanced "New API"-style OpenAI proxy (visible via its
 * `x-new-api-version` / `via: ...ens-cache...` response headers). The
 * FIRST request in a turn (no tool history yet) reliably succeeds; the
 * VERY NEXT request -- the one right after a tool call, once its result
 * is appended to `messages` -- intermittently gets routed to a worker
 * node that doesn't have whatever the first request's node cached
 * (a stale/expired tool-schema reference, a session/route entry, etc.)
 * and bounces back a generic, no-real-detail error. This is EXACTLY the
 * "any model I use, the moment it does one tool call it fails" pattern:
 * every BYOK model on this relay shares this one `resolveByokModel` code
 * path, so the glitch shows up on whichever model happens to hit it.
 *
 * This bug has surfaced under at least three different literal error
 * bodies so far, all on the second-request-after-a-tool-call shape, all
 * on this same relay:
 *   1. 404, "Function id '<uuid>' version 'null': Specified function in
 *      account '<id>' is not found"
 *   2. 5xx, bare "Internal server error" (no body detail at all)
 *   3. 404, {"error":{"message":"openai_error","type":"bad_response_status_code",...}}
 * -- i.e. exact-string matching one pattern at a time is a losing game
 * (each fix only covered the one already seen, the next glitch shape
 * just slipped through as "permanent"). The real fix: treat this whole
 * FAMILY the same way -- any 404 (this relay never legitimately 404s;
 * we never reference a function-id/session of any kind, we always send
 * the full inline `tools` array every turn, so a 404 here can only be
 * this relay's own internal routing glitch, never something our request
 * caused) OR any 5xx whose body is short and generic (no real detail
 * beyond a bare code/type -- a genuinely permanent error, e.g. a bad API
 * key or a real quota/auth problem, always comes back with actual
 * descriptive text identifying WHAT is wrong, which this class of
 * response never has).
 *
 * Genuinely permanent errors are still never retried: any 4xx OTHER than
 * 404, and any 5xx body containing a real permanent-error signal
 * (auth/quota/rate-limit/model-not-found keywords), passes straight
 * through untouched.
 *
 * FIXED (2026-07-25, confirmed live on the "Claudev" BYOK provider): a
 * 403 came back with `content-type: application/octet-stream`, a
 * `cf-ray` header (Cloudflare edge), and a genuinely BINARY body (not
 * gzip we failed to decode -- there was no content-encoding header at
 * all -- an actual non-text Cloudflare bot-challenge/block payload).
 * That shape never matched any existing rule (403 isn't in the 5xx
 * bucket, and none of the transient-body regexes can match binary
 * garbage), so it was treated as instantly permanent -- indistinguishable
 * to the user from "the model just stopped mid-turn," even though a
 * near-identical failure on this SAME provider label recovered clean
 * after exactly one retry minutes earlier. A genuine per-request auth
 * 403 from a real API (bad key, revoked token, forbidden model) always
 * comes back as small, readable JSON/text naming what's wrong -- an
 * edge/CDN-level bot challenge is structurally different (binary,
 * `cf-ray` present, no readable error message at all) and, like the
 * 502/503/504 infra case above, worth a few retries since it's about the
 * request/connection being flagged, not a fact about the account that a
 * retry can't change.
 */

import { logError } from '@entry/db/error-log';
// Side-effect import only -- this installs the shared keep-alive pool as
// the process's GLOBAL fetch dispatcher (see keep-alive-dispatcher.ts's
// 2026-07-23 fix note for why it must be global, never passed per-request
// via RequestInit against Node's built-in fetch).
import './keep-alive-dispatcher';

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 200;
const GENERIC_BODY_MAX_LENGTH = 400;

// Keywords that mean "this is a REAL, permanent, descriptive error" -- if
// any of these show up in an otherwise-generic-looking 5xx body, it's
// NOT the relay glitch, don't retry it away.
// FIXED (2026-07-27, real bug, user report: "on slow internet it's slow
// for the model to connect and run" -- confirmed live via error_logs: a
// monthly-usage-cap response from Opencode Zen, e.g. "Monthly usage
// limit reached. Resets in 18hr 59min...", matched NONE of the existing
// permanent-signal keywords (no literal "quota", "balance", or "rate
// limit" in that exact phrasing) and a 500 status with a short body, so
// it fell straight into the generic-short-5xx-body "retry it" bucket --
// 6 full attempts with growing backoff delay, EVERY message, for a
// condition that cannot possibly succeed until the cap resets hours
// later. Adding this keyword makes it fail on the first attempt instead
// of wasting several real seconds retrying something permanent-for-now.
export const PERMANENT_SIGNAL_PATTERN = /invalid[_ ]?api[_ ]?key|unauthorized|authentication|insufficient[_ ]?quota|insufficient[_ ]?balance|rate[_ ]?limit|usage[_ ]?limit|monthly[_ ]?limit|model[_ ]?not[_ ]?found|model[_ ]?is[_ ]?disabled|does not exist|permission|forbidden/i;

// FIXED (2026-07-25, confirmed live: Claude Opus 5 via freemodel.dev,
// real BYOK turn genuinely mid-work): the exact body
// {"type":"rate_limit_error","message":"Concurrency limit exceeded for
// account, please retry later"} was hitting PERMANENT_SIGNAL_PATTERN's
// `rate[_ ]?limit` keyword and being given up on INSTANTLY, no retry at
// all -- indistinguishable to the user from "the model just stopped".
// That keyword's original intent was catching genuine QUOTA exhaustion
// (no tokens/credit left until a plan resets, e.g. "insufficient_quota"),
// which really is permanent -- but a per-account CONCURRENCY/throughput
// cap (too many simultaneous requests RIGHT NOW) is a completely
// different, textbook-transient failure: the provider's own message
// here literally says "please retry later". Checked FIRST, before the
// permanent-signal check below, so it wins even though the same body
// also matches `rate[_ ]?limit` -- these phrasings never show up in a
// genuinely permanent error (a real dead API key or exhausted balance
// never says "retry later" or mentions concurrency).
const TRANSIENT_DESPITE_RATE_LIMIT_WORDING = /concurrency[_ ]?limit|too many (concurrent|simultaneous)|please retry|try again (in|later)|temporarily unavailable|overloaded/i;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractMessageText(bodyText: string): string {
  const trimmed = bodyText.trim();
  try {
    const parsed = JSON.parse(trimmed);
    const msg = typeof parsed === 'string' ? parsed : (parsed?.error?.message ?? parsed?.error ?? parsed?.message);
    return typeof msg === 'string' ? msg : trimmed;
  } catch {
    return trimmed;
  }
}

function matchesKnownTransientBody(status: number, bodyText: string, headers?: Headers): boolean {
  const trimmed = bodyText.trim();
  const messageText = extractMessageText(trimmed);

  // See TRANSIENT_DESPITE_RATE_LIMIT_WORDING's own comment -- must run
  // BEFORE the permanent-signal check a few lines down, on ANY status
  // code (not just 5xx), since a relay can wrap a concurrency error in
  // whatever HTTP status it wants (this one used a bare 500).
  if (TRANSIENT_DESPITE_RATE_LIMIT_WORDING.test(messageText) || TRANSIENT_DESPITE_RATE_LIMIT_WORDING.test(trimmed)) {
    return true;
  }

  // See file comment (2026-07-25 update) -- a 403 that's actually a
  // Cloudflare edge-level bot block/challenge (binary body, no readable
  // message, `cf-ray` present) is worth retrying; a real per-request auth
  // 403 always comes back as short readable text naming what's wrong, so
  // that case still falls through to "not transient" below untouched.
  if (status === 403 && headers?.get('cf-ray')) {
    const looksBinary = /[\u0000-\u0008\u000E-\u001F\uFFFD]/.test(bodyText) || !messageText;
    const looksLikeRealAuthError = PERMANENT_SIGNAL_PATTERN.test(messageText) || PERMANENT_SIGNAL_PATTERN.test(trimmed);
    if (looksBinary && !looksLikeRealAuthError) return true;
  }

  // Any 404 on this relay is the known routing glitch -- see file comment
  // for why a legitimate 404 is not possible for how we call this API.
  if (status === 404) return true;

  // 429 FAST-RETRY FIX (2026-07-29, real bug, owner report: "why does it
  // take long for ALL shared ai to respond"). This wrapper never handled
  // 429 at all -- a bare rate-limit response fell through every branch
  // here untouched and went straight back to the caller, which meant
  // EVERY 429 from ANY shared/BYOK provider skipped this wrapper's fast
  // ~200ms-based backoff entirely and hit the AI SDK's own generic outer
  // retry instead (2s/4s/8s/16s/32s exponential, see streamText's
  // `maxRetries` in direct/chat/route.ts) -- up to 62 real seconds of
  // pure waiting on a single turn before even one retry's actual request
  // latency is counted. Shared providers (many users pooling one
  // upstream account) hit momentary 429s far more often than a private
  // BYOK key ever would, so this was disproportionately a "shared AI"
  // problem specifically, matching the report exactly.
  //
  // For 429 specifically, PERMANENT_SIGNAL_PATTERN is too broad to reuse
  // as-is -- its `rate[_ ]?limit`/`usage[_ ]?limit` keywords are exactly
  // the boilerplate wording EVERY 429 uses regardless of whether it's a
  // momentary burst (retry in a second, totally normal) or a real
  // hours-long cap, so applying it here would just re-create the "every
  // 429 treated as permanent" problem this fix exists to solve. A 429 is
  // only genuinely NOT worth retrying here when the body names an actual
  // long reset window or hard balance/quota exhaustion (things a fast
  // in-process retry loop cannot possibly outlast) -- e.g. the real
  // Opencode Zen body seen in production, "Monthly usage limit reached.
  // Resets in 18hr 59min... enable usage from your available balance".
  // Everything else classified 429 -- the overwhelming common case, a
  // plain momentary rate-limit/burst response -- gets this wrapper's
  // fast, cheap backoff instead of the outer SDK layer's slow one.
  const HARD_429_CAP_PATTERN = /resets? in|monthly|insufficient[_ ]?balance|insufficient[_ ]?quota|available balance|out of (credits|quota)/i;
  if (status === 429) {
    if (HARD_429_CAP_PATTERN.test(messageText) || HARD_429_CAP_PATTERN.test(trimmed)) return false;
    return true;
  }

  if (status >= 500 && status < 600) {
    // A real, permanent error always names what's actually wrong.
    if (PERMANENT_SIGNAL_PATTERN.test(messageText) || PERMANENT_SIGNAL_PATTERN.test(trimmed)) return false;

    // FIXED (2026-07-23, confirmed live: freemodel.dev's own Cloudflare
    // front-door returned a full HTML "502: Bad gateway" error page --
    // Cloudflare's status widget showing the ORIGIN host itself down,
    // everything else (browser, CDN) green -- and it sailed straight
    // through as "not transient" because the GENERIC_BODY_MAX_LENGTH
    // check below only ever considered small JSON/text bodies. A full
    // HTML error page is always LONGER than that cap by construction (it
    // has a <head>, inline styles, etc.), so every single gateway-level
    // HTML error page was being misclassified as permanent and hitting
    // the user as a dead turn after only the AI SDK's own weak 2-attempt
    // default retry -- never even reaching THIS wrapper's real 6-attempt/
    // backoff retry loop at all.
    //
    // 502/503/504 are categorically gateway/infra-level codes -- a
    // load balancer or CDN edge reporting its origin is unreachable or
    // overloaded. No legitimate PERMANENT per-request error (bad key,
    // out of quota, model not found) is ever reported this way -- those
    // always come back as a real JSON body from the actual API itself,
    // which is a completely different response shape than an infra
    // front-door's own canned HTML page. So: always retry these three
    // codes, regardless of body length -- the length cap below still
    // applies to every OTHER 5xx (500, 507, 599, etc.) where a large
    // body really could mean something else and being conservative still
    // makes sense.
    if (status === 502 || status === 503 || status === 504) return true;

    // Otherwise: treat any short, generic 5xx body as the same family of
    // transient relay hiccup (covers "Internal server error", bare
    // {"error":{"type":"..."}} objects with no real detail, etc.)
    if (trimmed.length <= GENERIC_BODY_MAX_LENGTH) return true;
  }

  return false;
}

export interface GatewayRetryContext {
  /** Provider label, e.g. "iamhc.cn" -- lets error_logs answer "which
   *  relay is flaky" without cross-referencing request URLs by hand. */
  providerLabel?: string;
  userId?: string;
}

export function createGatewayRetryFetch(ctx?: GatewayRetryContext): typeof fetch {
  return async function gatewayRetryFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let lastResponse: Response | undefined;
    let retriedAtLeastOnce = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // The shared keep-alive pool is applied globally (module import
      // above), NOT passed here -- see keep-alive-dispatcher.ts.
      const response = await fetch(input, init);

      if (response.status < 400) {
        // RECOVERED-AFTER-RETRY (2026-07-21): previously this success was
        // completely invisible outside a live `vercel logs` tail --
        // console.warn on each attempt is ephemeral (gone once Vercel
        // rotates its short-lived log buffer), so there was literally no
        // durable record that a given provider/relay needed retries at
        // all, even when it recovered fine. Persisting this (lightweight,
        // no full response body) is what lets us later answer "is this
        // relay getting flakier over time" from error_logs instead of
        // only ever seeing the final failure (or nothing, if it recovered).
        if (retriedAtLeastOnce) {
          logError({
            source: 'byok-gateway-retry-recovered',
            error: new Error(`Recovered after ${attempt} retry attempt(s)`),
            userId: ctx?.userId,
            context: { providerLabel: ctx?.providerLabel, attempts: attempt + 1, finalStatus: response.status },
          });
        }
        return response;
      }

      // Peek at the body without consuming the one we might return --
      // event-stream or not, this relay's error responses are always a
      // single small JSON/text object, never a real stream, so buffering
      // it fully here is safe and cheap.
      const clone = response.clone();
      let bodyText = '';
      try {
        bodyText = await clone.text();
      } catch {
        return response; // couldn't read it, don't swallow a real error blind
      }

      if (!matchesKnownTransientBody(response.status, bodyText, response.headers)) return response;

      lastResponse = response;
      retriedAtLeastOnce = true;
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[byok] gateway transient ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying: ${bodyText.slice(0, 200)}`
        );
        await delay(RETRY_DELAY_MS * (attempt + 1));
      } else {
        // EXHAUSTED (2026-07-21): every prior attempt was only ever
        // console.warn'd -- the final give-up itself now gets a durable
        // row too (distinct source from the eventual streamText-level
        // error the caller will also see), specifically so retry-storm
        // patterns against one relay are queryable later, not just the
        // symptom the user actually experienced.
        logError({
          source: 'byok-gateway-retry-exhausted',
          error: new Error(`Gave up after ${MAX_RETRIES + 1} attempts, last status ${response.status}: ${bodyText.slice(0, 500)}`),
          userId: ctx?.userId,
          context: { providerLabel: ctx?.providerLabel, status: response.status, body: bodyText.slice(0, 1000) },
        });
      }
    }

    return lastResponse!;
  };
}
