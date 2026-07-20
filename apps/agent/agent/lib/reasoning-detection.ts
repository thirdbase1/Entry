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
 *    qwq/qvq, "thinking", "reasoning", the whole Claude 4+/5+ family,
 *    gpt-5, gemini 2.5+/3+, grok-3-mini/4, glm-4.5+, kimi-k2-thinking,
 *    deepseek-v3.1+) as a catch-all for models the Gateway catalog
 *    doesn't carry at all (a brand-new release, a niche open-weight
 *    fine-tune, a regional provider) OR — the real reason this tier
 *    matters even for models the catalog DOES know about — for when
 *    tier 1 never even got a chance to run at all: tier 1 depends on a
 *    live fetch to ai-gateway.vercel.sh succeeding from inside a Vercel
 *    serverless function; if that fetch fails/times out/changes shape,
 *    `getReasoningCapableGatewaySlugs()` fails closed (empty set), and
 *    tier 1 can never match anything, including a plain
 *    "claude-opus-4-6" from a BYOK connection — real Claude/GPT-5/Gemini
 *    reasoning family names hardcoded here are the fallback that keeps
 *    working even when the network dependency is unavailable.
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
  /deepseek-v3\.[1-9]/,
  /deepseek-v4/,
  /grok-3-mini/,
  /grok-4/,
  // Anthropic — every Claude 4.x/5.x model (opus/sonnet/haiku/fable)
  // supports extended thinking; only 3.x and earlier don't.
  /claude-(opus|sonnet|haiku|fable)-[4-9]/,
  // OpenAI — the whole GPT-5 family and o-series are reasoning models.
  /gpt-5/,
  // Google — Gemini 2.5+ and all Gemini 3.x are reasoning-capable.
  /gemini-(2\.5|3)/,
  // Zhipu / GLM 4.5+.
  /glm-(4\.[5-9]|5)/,
  // Moonshot Kimi K2 thinking variants.
  /kimi-k2.*thinking/,
  // Perplexity's reasoning-tuned Sonar.
  /sonar-reasoning/,
  // Mistral's reasoning line.
  /magistral/,
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
