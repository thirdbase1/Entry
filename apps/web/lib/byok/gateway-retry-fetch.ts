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
    // Otherwise: treat any short, generic 5xx body as the same family of
    // transient relay hiccup (covers "Internal server error", bare
    // {"error":{"type":"..."}} objects with no real detail, etc.)
    if (trimmed.length <= GENERIC_BODY_MAX_LENGTH) return true;
  }

  return false;
}

export function createGatewayRetryFetch(): typeof fetch {
  return async function gatewayRetryFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(input, init);

      if (response.status < 400) return response;

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
