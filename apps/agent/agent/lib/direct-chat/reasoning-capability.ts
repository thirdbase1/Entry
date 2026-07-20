/**
 * Server-side source of truth for "does this resolved model actually
 * support the AI SDK's portable `reasoning` effort control" — used to
 * GATE whether /api/direct/chat's route ever forwards a `reasoning:`
 * value to streamText at all.
 *
 * Why this exists (2026-07-11, confirmed real bug): the route used to
 * forward the user's selected reasoning effort unconditionally for every
 * single model, including plain non-reasoning ones. Verified directly
 * against OpenAI's own API docs/community reports: sending ANY
 * `reasoning_effort` value — even one that's valid for OTHER models — to
 * a non-reasoning model (e.g. a plain chat model without reasoning
 * support) returns a hard 400 ("Invalid 'reasoning_effort' for
 * non-reasoning model"). @ai-sdk/openai-compatible's adapter (what every
 * BYOK OpenAI-style connection goes through) passes the value straight
 * through with no validation of its own — so this was a real, reproducible
 * way for a turn to fail outright depending solely on which model the
 * user had picked, with the localStorage-persisted reasoning effort
 * (defaults to 'medium') silently carried over into a chat with a model
 * that never supported it in the first place.
 *
 * Reuses the exact same two signals already used client-side in
 * chat-config.tsx's model picker (so "does the UI show the reasoning
 * control" and "does the server actually honor it" never disagree):
 * 1. Gateway models — the live catalog's own `reasoning` tag.
 * 2. BYOK models — the same fingerprint/naming-pattern heuristic from
 *    lib/reasoning-detection.ts, since a BYOK connection has no catalog
 *    to authoritatively ask.
 */
import { looksLikeReasoningModel } from '../reasoning-detection.js';

let cache: { slugs: Set<string>; fetchedAt: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

export async function getReasoningCapableGatewaySlugs(): Promise<Set<string>> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.slugs;
  try {
    const res = await fetch('https://ai-gateway.vercel.sh/v1/models/catalog');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models: { slug: string; providers: { tags?: string[] }[] }[] };
    const slugs = new Set(data.models.filter(m => m.providers.some(p => p.tags?.includes('reasoning'))).map(m => m.slug));
    cache = { slugs, fetchedAt: Date.now() };
    return slugs;
  } catch (err) {
    // Best-effort — on failure, fail CLOSED (treat as not-reasoning-capable)
    // rather than open: silently forwarding a reasoning param to a model
    // that can't handle it breaks the whole turn, whereas not applying a
    // reasoning effort the model would have supported just means it runs
    // at its own default — degraded, never broken. Logged (not swallowed
    // silently) because this failure mode is exactly what falls back to
    // the static KNOWN_REASONING_PATTERNS tier in reasoning-detection.ts
    // for BYOK models — worth knowing about if reasoning ever mysteriously
    // stops showing for a model that should support it.
    console.error('[reasoning-capability] Gateway catalog fetch failed, failing closed', err);
    return cache?.slugs ?? new Set();
  }
}

/** True if this resolved Gateway slug (e.g. "anthropic/claude-opus-4.5") supports reasoning effort. */
export async function isGatewayModelReasoningCapable(slug: string): Promise<boolean> {
  const slugs = await getReasoningCapableGatewaySlugs();
  return slugs.has(slug);
}

/** True if this BYOK model (arbitrary id/label, no catalog) looks reasoning-capable. */
export async function isByokModelReasoningCapable(modelId: string): Promise<boolean> {
  const gatewaySlugs = await getReasoningCapableGatewaySlugs();
  return looksLikeReasoningModel(modelId, Array.from(gatewaySlugs));
}
