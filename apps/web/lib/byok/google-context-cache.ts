/**
 * Real Gemini prompt caching for BYOK GOOGLE-compatibility connections.
 *
 * Why this exists (2026-07-25, confirmed live: real production log showed
 * a Gemini 2.5 Flash turn with `inputTokenDetails.cacheReadTokens: 0` and
 * `cacheWriteTokens: undefined` on a 101k-input-token turn in an
 * already-long-running chat): unlike Anthropic, Gemini has NO equivalent
 * of a simple per-request `cache_control: {type:'ephemeral'}` marker you
 * can just attach to a message. `@ai-sdk/google` only supports caching via
 * `providerOptions.google.cachedContent`, a REFERENCE to a `CachedContent`
 * resource that must already exist -- created through Gemini's own
 * separate `cachedContents` REST endpoint, with its own TTL and (per
 * Google's docs) a minimum content-size floor before a model will even
 * accept creating one. There is no automatic/implicit fallback we get for
 * free -- prompt-cache.ts's existing `anthropic`-namespaced marker is
 * silently ignored by Google's provider (unrecognized key), so a
 * Gemini-model turn got literally zero caching benefit from this app
 * before this file existed.
 *
 * Scope: only ever used for real Google endpoints (never a third-party
 * relay imitating Gemini's API shape -- same "isThirdPartyXRelay" concern
 * resolve-model.ts already tracks for Anthropic/OpenAI-responses; a relay
 * has no real `cachedContents` store to honor this against).
 *
 * Fail-safe by construction: every path either returns a real cache
 * resource name or `null` -- never throws out to the caller. Caching is
 * purely an optimization; a broken/slow/rejected cache-creation call must
 * never break or delay the actual chat turn itself. A short internal
 * timeout enforces this even if Google's cache endpoint itself hangs.
 *
 * In-memory only (keyed by content hash, not persisted): losing this on a
 * process restart just means the next turn recreates the cache instead of
 * reusing one that may already be expired anyway -- never a correctness
 * issue, and avoids a schema migration for what's purely a perf cache.
 */
import { createHash } from 'node:crypto';

const CACHE_TTL_SECONDS = 300; // 5m -- matches prompt-cache.ts's Anthropic ephemeral TTL
// Conservative floor: Gemini's real per-model minimum (varies, commonly
// ~1024-4096 tokens depending on model) is token-based, not char-based --
// this char count is a deliberately generous UNDER-estimate (~1 token ≈ 4
// chars, so 6000 chars ≈ 1500 tokens) purely to skip a cache-creation call
// we already know is too small to be accepted, saving a wasted round trip.
// A content block that's actually large enough but slips under this floor
// just runs uncached that turn -- never an error, never a broken turn.
const MIN_CACHEABLE_CHARS = 6000;

interface CacheEntry {
  name: string;
  expiresAt: number;
}

const cacheStore = new Map<string, CacheEntry>();

function hashKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`google-context-cache: timed out after ${ms}ms`)), ms)),
  ]);
}

export interface PrepareGoogleCacheArgs {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  systemText: string;
  toolSchemasJson: string;
  userId?: string;
}

/**
 * Returns an existing (still-valid) or freshly-created `cachedContents/...`
 * resource name for this exact (model, system prompt, tool schema)
 * combination, or `null` if caching isn't applicable/possible right now
 * (too small, creation failed, endpoint unreachable, etc). Never throws.
 */
export async function prepareGoogleCache(args: PrepareGoogleCacheArgs): Promise<string | null> {
  const { apiKey, baseUrl, modelId, systemText, toolSchemasJson, userId } = args;
  const combined = systemText + toolSchemasJson;
  if (combined.length < MIN_CACHEABLE_CHARS) return null;

  const key = hashKey([modelId, systemText, toolSchemasJson]);
  const existing = cacheStore.get(key);
  const now = Date.now();
  // Refresh a little before the real TTL to avoid a request landing right
  // at expiry and getting a "cache not found" error from Gemini mid-turn.
  if (existing && existing.expiresAt - now > 20_000) {
    return existing.name;
  }

  // baseUrl for a real Google connection is the Generative Language API
  // root (e.g. https://generativelanguage.googleapis.com); the
  // cachedContents endpoint lives under the same host's v1beta surface
  // regardless of which model-serving path the chat calls itself go
  // through, so this is derived from origin only, not the full baseUrl.
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return null;
  }

  try {
    const res = await withTimeout(
      fetch(`${origin}/v1beta/cachedContents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          model: `models/${modelId}`,
          contents: [{ role: 'user', parts: [{ text: systemText }] }],
          ttl: `${CACHE_TTL_SECONDS}s`,
        }),
      }),
      8_000,
    );

    if (!res.ok) {
      // Expected/benign: model doesn't support caching, content still too
      // small by Gemini's real token-based floor, transient 5xx, etc --
      // never worth retrying or surfacing to the user, just skip caching
      // this turn like before this file existed.
      const bodyText = await res.text().catch(() => '');
      console.warn('[google-context-cache] creation skipped', { modelId, status: res.status, userId, body: bodyText.slice(0, 300) });
      return null;
    }

    const data = (await res.json()) as { name?: string };
    if (!data.name) return null;

    cacheStore.set(key, { name: data.name, expiresAt: now + CACHE_TTL_SECONDS * 1000 });
    return data.name;
  } catch (err) {
    console.warn('[google-context-cache] creation failed, continuing uncached', { modelId, userId, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
