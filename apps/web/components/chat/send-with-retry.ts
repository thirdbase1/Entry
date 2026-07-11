/**
 * Retries a chat "send" call up to twice with backoff, but ONLY for a
 * genuine network-level failure -- the request never actually reached (or
 * a response never actually came back from) the server at all. Real quote
 * from the user (2026-07-11): "make sure every request goes through to
 * the model" -- a flaky mobile connection or a proxy hiccup at the exact
 * moment someone hits send shouldn't just silently drop their message
 * with a generic error banner and nothing else tried.
 *
 * Deliberately narrow: once a request DOES reach the server, a failure
 * comes back as a resolved stream/response containing an error part
 * instead of a rejected promise (see route.ts's onError + useChat/
 * useEveAgent's own onError callbacks, both already surfaced to the UI as
 * a real banner) -- retrying THOSE would risk the model processing the
 * same user turn twice. Only a promise rejection whose error looks like a
 * transport-level failure (not an AbortError from the user's own `stop`,
 * not a structured API error) is worth retrying here.
 */
function looksLikeNetworkFailure(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const lower = message.toLowerCase();
  return (
    lower.includes('failed to fetch') || // Chrome/Firefox
    lower.includes('load failed') || // Safari
    lower.includes('network') ||
    lower.includes('networkerror') ||
    lower.includes('err_network') ||
    lower.includes('err_internet_disconnected') ||
    lower.includes('err_connection') ||
    err instanceof TypeError // fetch() rejects with a plain TypeError on any network-level failure
  );
}

const RETRY_DELAYS_MS = [800, 2500];

export async function sendWithRetry<T>(send: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await send();
    } catch (err) {
      lastErr = err;
      if (attempt === RETRY_DELAYS_MS.length || !looksLikeNetworkFailure(err)) throw err;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}

/**
 * Confirmed real bug (2026-07-11), found verifying error surfacing end to
 * end: AI SDK's HttpChatTransport (which useChat/DefaultChatTransport sits
 * on top of, in direct-chat-interface.tsx) throws `new Error(await
 * response.text())` for ANY non-ok HTTP response -- and every route here
 * (via withApiErrorHandling / plain Response.json({ error }) for the
 * pre-flight 400s) returns that error as a JSON body, e.g.
 * `{"error":"No BYOK key configured for this provider"}`. That raw JSON
 * string was landing in the turnError banner completely unparsed --
 * technically "shows in the UI" but as literal curly braces and quotes
 * instead of a readable sentence. Only matters for FAILURES BEFORE
 * streaming starts (bad key, unknown model, unauthorized, malformed body)
 * since those are the only ones that ever return a non-ok status; a
 * failure mid-stream already comes through as plain readable text via the
 * route's own onError (see route.ts).
 */
export function readableChatErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.error === 'string' && parsed.error) return parsed.error;
      if (parsed && typeof parsed.message === 'string' && parsed.message) return parsed.message;
    } catch {
      // not actually JSON despite the leading brace -- fall through
    }
  }
  return trimmed || 'Something went wrong generating a response. Please try again.';
}
