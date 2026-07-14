/**
 * Custom `fetch` wrapper for OpenAI-compatible BYOK providers, retrying
 * specific transient failure patterns seen on at least one relay
 * (iamhc.cn, 2026-07-11/2026-07-15 real user reports) rather than letting
 * the SDK's default classifier treat them as permanent.
 *
 * 1. AI_APICallError, statusCode 404:
 *    "Function id '<uuid>' version 'null': Specified function in account
 *    '<id>' is not found"
 *
 *    This is NOT something our own request causes -- confirmed by
 *    inspecting the actual outgoing `requestBodyValues`: we always send
 *    the full `tools` array inline, every turn, with no function-id/
 *    reference of any kind. The error is generated entirely on the
 *    relay's own backend: it looks like an internal tool-schema cache/
 *    dedup layer on their side (visible via the `x-new-api-version` /
 *    `via: ...ens-cache...` response headers, i.e. a multi-node
 *    load-balanced "New API"-style OpenAI proxy) that occasionally routes
 *    a request to a worker node holding a stale/expired reference to a
 *    tool-schema it cached from an earlier request on a DIFFERENT node.
 *
 * 2. Bare 5xx with a generic, bodyless-looking "Internal server error"
 *    (2026-07-15, real report -- MiniMax-M3 on the same relay failing
 *    every turn on one chat with exactly this message, right after the
 *    404 bug above was fixed for a different model on the identical
 *    relay). Same multi-node relay, same shape of problem: a transient
 *    backend hiccup on whichever node handled this one request, not a
 *    real, permanent "this model/account is broken" signal -- a genuine
 *    persistent account/model failure would come back with an actual
 *    descriptive error body, not this generic one-liner.
 *
 * The SDK's default error classifier correctly refuses to auto-retry
 * either of these (a 404/500 is normally a permanent signal) -- but
 * empirically here they're transient routing/backend glitches: the
 * identical request a few hundred ms later, potentially hitting a
 * different backend node, succeeds.
 *
 * Retries up to twice with a short delay ONLY when the response actually
 * matches one of these two exact known-transient patterns; every other
 * 404/5xx (a genuinely wrong baseURL/model id, or a real descriptive
 * server error) is left completely alone and surfaces normally.
 */

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 400;

const TRANSIENT_FUNCTION_CACHE_PATTERN = /Function id '[^']*'.*is not found/i;
// Deliberately narrow: matches ONLY a short, generic, no-detail message --
// a real error body (stack trace, provider-specific error code/object,
// descriptive text) does NOT match this and is never retried/swallowed.
const TRANSIENT_GENERIC_5XX_PATTERN = /^\s*"?internal server error"?\s*$/i;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 404 || (status >= 500 && status < 600);
}

function matchesKnownTransientBody(bodyText: string): boolean {
  const trimmed = bodyText.trim();
  if (TRANSIENT_FUNCTION_CACHE_PATTERN.test(trimmed)) return true;
  // A real JSON error object always carries more than just this phrase
  // (a code, a type, a request id, something) -- only match when the
  // ENTIRE body is essentially just this one generic phrase, optionally
  // JSON-quoted or wrapped in a minimal `{"error": "..."}` shape.
  if (TRANSIENT_GENERIC_5XX_PATTERN.test(trimmed)) return true;
  try {
    const parsed = JSON.parse(trimmed);
    const msg = typeof parsed === 'string' ? parsed : parsed?.error?.message ?? parsed?.error ?? parsed?.message;
    if (typeof msg === 'string' && TRANSIENT_GENERIC_5XX_PATTERN.test(msg.trim())) return true;
  } catch {
    // not JSON -- already checked the plain-text case above
  }
  return false;
}

export function createGatewayRetryFetch(): typeof fetch {
  return async function gatewayRetryFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(input, init);

      if (!isRetryableStatus(response.status)) return response;

      // Peek at the body without consuming the one we might return --
      // event-stream or not, this specific gateway bug always returns a
      // single small JSON error object as the entire body, never a real
      // stream, so buffering it fully here is safe and cheap.
      const clone = response.clone();
      let bodyText = '';
      try {
        bodyText = await clone.text();
      } catch {
        return response; // couldn't read it, don't swallow a real error blind
      }

      if (!matchesKnownTransientBody(bodyText)) return response;

      lastResponse = response;
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[byok] gateway transient ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying: ${bodyText.slice(0, 200)}`
        );
        await delay(RETRY_DELAY_MS * (attempt + 1));
      }
    }

    return lastResponse!;
  };
}
