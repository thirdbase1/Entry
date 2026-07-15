/**
 * Normalizes a user-entered BYOK base URL so both our own fetch-models
 * probe and the real @ai-sdk/anthropic client hit the same path.
 *
 * Root cause this fixes: the official Anthropic API's root is
 * `https://api.anthropic.com` with the real API living under `/v1`
 * (`/v1/messages`, `/v1/models`). `@ai-sdk/anthropic`'s `createAnthropic()`
 * only auto-appends `/v1` when baseURL is EXACTLY the default
 * `https://api.anthropic.com` (see its `normalizeBaseURL()`); for any
 * custom/BYOK baseURL it uses whatever you give it, verbatim, then does
 * `${baseURL}/messages`. Users naturally paste just the origin (e.g.
 * `https://capi.aerolink.lat`) the same way they'd paste
 * `https://api.anthropic.com` — expecting the app to know where `/v1`
 * lives, same as Anthropic's own official base URL. Without this, every
 * chat completion AND the "fetch models" probe both silently hit the
 * wrong path (missing `/v1`) and the remote proxy returns whatever its
 * catch-all route does for that (401/403/305/whatever) instead of a
 * useful "add /v1 to your URL" message.
 *
 * Only applies to ANTHROPIC compatibility — OPENAI-compatible convention
 * already expects the user to include `/v1` themselves (e.g.
 * `https://api.openai.com/v1`), and GOOGLE's real API root
 * (`generativelanguage.googleapis.com/v1beta`) varies by version, so we
 * leave those two untouched. OPENAI_RESPONSES is left untouched too —
 * unlike the official `https://api.openai.com/v1` default, aggregators
 * proxying the Responses API shape (e.g. Kie.ai) put a per-model-family
 * segment before `/v1` (`/grok/v1`, `/gpt/v1`, ...) that we have no way to
 * guess, so the user must paste the full path up to and including `/v1`
 * themselves -- the AI SDK then appends `/responses` on top of exactly
 * that.
 */
export function normalizeBaseUrl(compatibility: 'OPENAI' | 'ANTHROPIC' | 'GOOGLE' | 'OPENAI_RESPONSES', rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.replace(/\/+$/, '');
  if (compatibility === 'ANTHROPIC' && !/\/v1$/.test(trimmed)) {
    return `${trimmed}/v1`;
  }
  return trimmed;
}
