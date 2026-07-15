/**
 * Resolves AI Gateway model ids dynamically from the LIVE public model
 * catalog. No model id is ever hardcoded in source — every agent.ts
 * (primary + subagents) calls into this at module-eval time via a
 * top-level `await`, so whichever model the Gateway currently considers
 * best-available for a provider family is picked automatically, with zero
 * code changes needed when providers ship new versions.
 *
 * Deliberately hits the SAME unauthenticated public endpoint eve's own
 * compiler uses internally for its context-window catalog lookup
 * (`https://ai-gateway.vercel.sh/v1/models/catalog`) rather than
 * `@ai-sdk/gateway`'s `gateway.getAvailableModels()`, which requires
 * `AI_GATEWAY_API_KEY` / Vercel OIDC auth that may not be present at
 * "eve build" time. This endpoint needs no auth at all.
 */

interface CatalogProvider {
  provider: string;
  providerModelId: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  tags?: string[];
}

interface CatalogModel {
  slug: string;
  providers: CatalogProvider[];
}

interface CatalogResponse {
  models: CatalogModel[];
  providerAliases: Record<string, string>;
}

let cached: { data: CatalogResponse; fetchedAt: number } | null = null;
const CATALOG_TTL_MS = 5 * 60 * 1000;

async function fetchCatalog(): Promise<CatalogResponse> {
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return cached.data;
  }
  const res = await fetch('https://ai-gateway.vercel.sh/v1/models/catalog');
  if (!res.ok) {
    throw new Error(`AI Gateway model catalog request failed: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as CatalogResponse;
  cached = { data, fetchedAt: Date.now() };
  return data;
}

function bestContextWindow(model: CatalogModel): number {
  return Math.max(0, ...model.providers.map(p => p.contextWindowTokens ?? 0));
}

function hasTag(model: CatalogModel, tag: string): boolean {
  return model.providers.some(p => p.tags?.includes(tag));
}

/**
 * Picks the best currently-available model for a provider family (e.g.
 * "anthropic", "openai", "google").
 *
 * CHANGED 2026-07-15, confirmed real cause of "the AI itself feels slow,
 * not just streaming": this used to rank purely by context-window size
 * (`bestContextWindow`), which is a proxy for CAPABILITY, not speed — in
 * practice it always landed on the single heaviest, slowest model in the
 * whole provider family for every provider, every agent (root +
 * subagents), every single turn, regardless of whether the turn actually
 * needed a 1M-token-context flagship model. Confirmed the live catalog
 * genuinely exposes a `'fast'` tag on specific model entries (e.g.
 * anthropic/claude-opus-4.7, claude-opus-4.8 as of this writing) meant
 * exactly for this — a real, provider-declared speed-optimized tier,
 * not a guess on our part. Now prefers any `'fast'`-tagged candidate
 * first (still tie-broken by context window / slug among those, so we
 * still get the newest/strongest "fast" variant), and only falls back to
 * the old biggest-context-window ranking across ALL candidates when the
 * provider doesn't expose a fast-tagged option at all — so this never
 * makes a provider with no fast tier unusable, it only takes the win
 * where the catalog actually offers one.
 */
export async function resolveModelIdForProvider(provider: string): Promise<string> {
  const { models } = await fetchCatalog();
  const candidates = models.filter(
    m => m.slug.startsWith(`${provider}/`) && m.providers.some(p => (p.contextWindowTokens ?? 0) > 0)
  );
  if (candidates.length === 0) {
    throw new Error(`No AI Gateway models found for provider "${provider}" in the live catalog.`);
  }
  const rank = (a: CatalogModel, b: CatalogModel) => bestContextWindow(b) - bestContextWindow(a) || b.slug.localeCompare(a.slug);
  const fastCandidates = candidates.filter(m => hasTag(m, 'fast'));
  const pool = fastCandidates.length > 0 ? fastCandidates : candidates;
  pool.sort(rank);
  return pool[0].slug;
}
