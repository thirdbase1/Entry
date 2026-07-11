/**
 * Custom `fetch` wrapper for OpenAI-compatible BYOK providers, retrying a
 * specific transient gateway bug seen on at least one relay (iamhc.cn,
 * DeepSeek-V4-Flash, 2026-07-11 real user report):
 *
 *   AI_APICallError, statusCode 404:
 *   "Function id '<uuid>' version 'null': Specified function in account
 *   '<id>' is not found"
 *
 * This is NOT something our own request causes -- confirmed by inspecting
 * the actual outgoing `requestBodyValues`: we always send the full `tools`
 * array inline, every turn, with no function-id/reference of any kind. The
 * error is generated entirely on the relay's own backend: it looks like an
 * internal tool-schema cache/dedup layer on their side (visible via the
 * `x-new-api-version` / `via: ...ens-cache...` response headers, i.e. a
 * multi-node load-balanced "New API"-style OpenAI proxy) that occasionally
 * routes a request to a worker node holding a stale/expired reference to a
 * tool-schema it cached from an earlier request on a DIFFERENT node. The
 * SDK's default error classifier correctly refuses to auto-retry a 404 (a
 * 404 is normally a permanent "this resource doesn't exist" signal) -- but
 * empirically here it's a transient routing glitch: the identical request
 * a few hundred ms later, potentially hitting a different backend node,
 * succeeds.
 *
 * Retries up to twice with a short delay ONLY when the response actually
 * matches this exact known-transient pattern; every other 404 (a genuinely
 * wrong baseURL/model id) is left completely alone and surfaces normally.
 */

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 400;

const TRANSIENT_FUNCTION_CACHE_PATTERN = /Function id '[^']*'.*is not found/i;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createGatewayRetryFetch(): typeof fetch {
  return async function gatewayRetryFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(input, init);

      if (response.status !== 404) return response;

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

      if (!TRANSIENT_FUNCTION_CACHE_PATTERN.test(bodyText)) return response;

      lastResponse = response;
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[byok] gateway function-cache 404 (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying: ${bodyText.slice(0, 200)}`
        );
        await delay(RETRY_DELAY_MS * (attempt + 1));
      }
    }

    return lastResponse!;
  };
}
