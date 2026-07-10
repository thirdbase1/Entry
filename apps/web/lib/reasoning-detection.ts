/**
 * Best-effort reasoning-capability detection for a BYOK model id.
 *
 * BYOK connections point at an arbitrary user-supplied base URL — there's
 * no catalog API to ask "does this model support reasoning" the way
 * /api/server/models can for Gateway models (see that route's
 * `getReasoningCapableSlugs`, which cross-references the Gateway's real
 * public catalog tags). Two-tier fallback instead:
 *
 * 1. Fingerprint match against the SAME Gateway catalog reasoning ids
 *    already fetched for the Gateway model list (zero extra request) — a
 *    BYOK connection serving e.g. "claude-opus-4-5-20260514" or
 *    "deepseek-r1-0528" is very likely running the *same* underlying
 *    model the Gateway also knows about as "anthropic/claude-opus-4.5" /
 *    "deepseek/deepseek-r1", just via a different (self-hosted/proxy/
 *    direct) endpoint and its own exact version/date suffix. Normalize
 *    both sides (lowercase, strip all non-alphanumerics) and check
 *    substring containment either direction.
 * 2. Static well-known reasoning-family naming patterns (o1/o3/o4, r1,
 *    qwq/qvq, "thinking", "reasoning") as a catch-all for models the
 *    Gateway catalog doesn't carry at all (a brand-new release, a niche
 *    open-weight fine-tune, a regional provider) but that still follow
 *    the naming convention every provider in this space converged on.
 *
 * Both tiers are heuristic, not authoritative — but the alternative is
 * either always showing the control (confusing on plain non-reasoning
 * models) or never showing it for BYOK (hides a real feature from every
 * BYOK reasoning model). This gets the large majority right without
 * requiring the user to know the AI SDK's internals.
 */
function normalize(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const KNOWN_REASONING_PATTERNS: RegExp[] = [
  /\bo1\b/,
  /\bo3\b/,
  /\bo4\b/,
  /\br1\b/,
  /\bqwq\b/,
  /\bqvq\b/,
  /thinking/,
  /reasoning/,
  /deepseek-r/,
  /grok-3-mini/,
  /grok-4/,
];

/** Minimum normalized length for a Gateway slug fingerprint to count as a
 *  real match — guards against e.g. a 2-3 char fragment matching almost
 *  anything by pure chance. */
const MIN_FINGERPRINT_LENGTH = 5;

export function looksLikeReasoningModel(modelId: string, gatewayReasoningIds: readonly string[]): boolean {
  if (!modelId) return false;
  const norm = normalize(modelId);

  if (norm) {
    for (const gatewayId of gatewayReasoningIds) {
      // Gateway ids are "provider/model-slug" (e.g. "anthropic/claude-opus-4.5") —
      // only the model-slug half is ever meaningful to compare against a BYOK
      // model's own id, which never carries a Gateway provider prefix.
      const slug = gatewayId.includes('/') ? gatewayId.slice(gatewayId.indexOf('/') + 1) : gatewayId;
      const normSlug = normalize(slug);
      if (normSlug.length < MIN_FINGERPRINT_LENGTH) continue;
      if (norm.includes(normSlug) || normSlug.includes(norm)) return true;
    }
  }

  return KNOWN_REASONING_PATTERNS.some(re => re.test(modelId.toLowerCase()));
}
