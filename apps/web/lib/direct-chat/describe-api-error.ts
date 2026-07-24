/**
 * Extracts a real, readable reason from a model-call error for both the
 * client-visible error banner AND the persisted fallback text.
 *
 * Real bug found live (2026-07-24, user report: "the agent stop, then
 * am not seeing all the tool call... everything wipe" -- turned out
 * nothing was actually lost server-side, see persist-chat-events.ts, but
 * the freemodel.dev BYOK relay's 402 "Usage limit reached" response was
 * showing up to the user as a completely generic, useless "No response
 * came back this turn and the provider did not report a reason" message
 * -- which reads exactly like a silent crash/wipe even though the real,
 * specific, actionable reason was sitting right there in the error the
 * whole time.
 *
 * Root cause, confirmed directly from Render's logs: the AI SDK's
 * `APICallError` (thrown by the openai-compatible provider wrapper on any
 * non-2xx response) came through with `error.message === ''` for this
 * specific relay. That happens because the SDK's own message-extraction
 * expects an OpenAI-shaped error envelope (`{"error":{"message":"..."}}`,
 * an OBJECT under `.error`), but freemodel.dev returns
 * `{"error":"Usage limit reached, will reset on today at 8:23 PM
 * (UTC+8)"}` -- a plain STRING under `.error`, not an object -- so the
 * SDK's own `.error.message` lookup finds nothing and falls back to an
 * empty message. The real text is still sitting untouched on the error's
 * own `responseBody` field the whole time; this function is what
 * actually reads it out from there instead of trusting `.message` blindly.
 *
 * Used in BOTH failure-message call sites (route.ts's outer onError,
 * which sets what the client sees AND -- via the exact same returned
 * string becoming the persisted 'error' part's errorText, which
 * fill-empty-refusal.ts's `hasRealContent` already treats as real content
 * -- determines whether the persisted chat history shows the real reason
 * or falls back to the generic filler text) and direct-chat-core.ts's
 * matching onError (the direct-chat channel's own copy of this same
 * stream-error path).
 */
export function describeApiCallError(error: unknown): string {
  if (error instanceof Error) {
    const trimmedMessage = error.message?.trim();
    if (trimmedMessage) return trimmedMessage;

    // error.message was empty (or whitespace-only) -- this is exactly the
    // freemodel.dev-shaped case above. Try every other place a real
    // reason could be hiding before giving up.
    const err = error as Error & {
      responseBody?: unknown;
      statusCode?: number;
      data?: unknown;
    };

    if (typeof err.responseBody === 'string' && err.responseBody.trim()) {
      const raw = err.responseBody.trim();
      try {
        const parsed = JSON.parse(raw);
        // OpenAI-standard shape: {"error": {"message": "..."}}
        if (parsed?.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string' && parsed.error.message.trim()) {
          return parsed.error.message.trim();
        }
        // freemodel.dev / many simpler relays: {"error": "plain string"}
        if (typeof parsed?.error === 'string' && parsed.error.trim()) {
          return parsed.error.trim();
        }
        // Some relays: {"message": "..."}
        if (typeof parsed?.message === 'string' && parsed.message.trim()) {
          return parsed.message.trim();
        }
      } catch {
        // Not JSON -- the raw response body text is still more useful
        // than nothing, as long as it's short enough to be readable
        // (long bodies are almost always an HTML error page, not a
        // real message, and would just be noise to show the user).
        if (raw.length > 0 && raw.length < 300) return raw;
      }
    }

    if (typeof err.statusCode === 'number') {
      return `The model provider returned an error (HTTP ${err.statusCode}). Please try again, or switch models if this keeps happening.`;
    }

    return 'Something went wrong generating a response. Please try again.';
  }
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Something went wrong generating a response. Please try again.';
}
