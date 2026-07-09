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

/**
 * Picks the strongest currently-available model for a provider family
 * (e.g. "anthropic", "openai", "google"), ranked by context window size,
 * then by slug (descending) as a tiebreaker — newer point releases with an
 * identical window (e.g. "claude-sonnet-4.6" vs "claude-sonnet-4") sort
 * after their predecessor and win.
 */
export async function resolveModelIdForProvider(provider: string): Promise<string> {
  const { models } = await fetchCatalog();
  const candidates = models.filter(
    m => m.slug.startsWith(`${provider}/`) && m.providers.some(p => (p.contextWindowTokens ?? 0) > 0)
  );
  if (candidates.length === 0) {
    throw new Error(`No AI Gateway models found for provider "${provider}" in the live catalog.`);
  }
  candidates.sort((a, b) => bestContextWindow(b) - bestContextWindow(a) || b.slug.localeCompare(a.slug));
  return candidates[0].slug;
}
