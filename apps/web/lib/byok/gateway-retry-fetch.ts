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
 */

import { logError } from '@entry/db/error-log';
// Side-effect import only -- this installs the shared keep-alive pool as
// the process's GLOBAL fetch dispatcher (see keep-alive-dispatcher.ts's
// 2026-07-23 fix note for why it must be global, never passed per-request
// via RequestInit against Node's built-in fetch).
import './keep-alive-dispatcher';

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 350;
const GENERIC_BODY_MAX_LENGTH = 400;

// Keywords that mean "this is a REAL, permanent, descriptive error" -- if
// any of these show up in an otherwise-generic-looking 5xx body, it's
// NOT the relay glitch, don't retry it away.
const PERMANENT_SIGNAL_PATTERN = /invalid[_ ]?api[_ ]?key|unauthorized|authentication|insufficient[_ ]?quota|insufficient[_ ]?balance|rate[_ ]?limit|model[_ ]?not[_ ]?found|does not exist|permission|forbidden/i;

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

function matchesKnownTransientBody(status: number, bodyText: string): boolean {
  const trimmed = bodyText.trim();
  const messageText = extractMessageText(trimmed);

  // Any 404 on this relay is the known routing glitch -- see file comment
  // for why a legitimate 404 is not possible for how we call this API.
  if (status === 404) return true;

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

      if (!matchesKnownTransientBody(response.status, bodyText)) return response;

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
