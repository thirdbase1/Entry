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

/**
 * ADDED (2026-07-18, "agent can specify provider and model on the agent
 * tool call... the agent see all the provider and model... do it super
 * simple so selecting doesn't take time"):
 *
 * The delegate tool's `provider`/`model` params used to be plain
 * free-text strings -- the calling model had to already know (or guess)
 * valid provider names and exact model slugs, with zero enforcement until
 * the tool actually ran and `resolveModelIdForProvider` either found a
 * match or threw. A wrong guess meant a wasted round trip: the whole
 * delegate call would fail, then the model would have to re-call it with
 * a corrected guess -- exactly the "takes time" complaint.
 *
 * This builds one summary of the LIVE catalog, grouped by provider, with
 * a few concrete top model ids per provider -- used to (a) build a real
 * `z.enum(...)` for `provider` so an invalid provider is rejected by
 * schema validation before execute() ever runs (an instant, structured
 * correction instead of a failed tool call), and (b) give `model`'s
 * description an actual menu of real, currently-valid ids to pick from
 * directly, instead of asking the model to recall or invent one.
 */
export interface CatalogMenu {
  /** Every provider family with at least one usable model right now -- the live z.enum() source. */
  providers: string[];
  /** Human-readable "provider: id-one, id-two, ..." lines, a few concrete picks per provider (the curated top few, NOT the full catalog). */
  menuText: string;
  /**
   * EVERY concrete "provider/model" id in the live catalog (not just the curated top-3-per-provider
   * shown in menuText) -- deliberately the FULL set, so validating an explicit `model` guess against
   * this can never produce a false-positive rejection of a real model that just isn't one of the
   * handful featured in the compact menu.
   */
  allModelIds: Set<string>;
}

const FALLBACK_PROVIDERS = ['anthropic', 'google', 'openai', 'deepseek', 'xai', 'moonshotai', 'zai'];

export async function getCatalogMenu(): Promise<CatalogMenu> {
  try {
    const { models } = await fetchCatalog();
    const byProvider = new Map<string, CatalogModel[]>();
    for (const m of models) {
      const provider = m.slug.split('/')[0];
      if (!provider || !m.providers.some(p => (p.contextWindowTokens ?? 0) > 0)) continue;
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider)!.push(m);
    }
    const providers = [...byProvider.keys()].sort();
    if (providers.length === 0) throw new Error('Live catalog returned zero usable providers.');
    const rank = (a: CatalogModel, b: CatalogModel) => bestContextWindow(b) - bestContextWindow(a) || b.slug.localeCompare(a.slug);
    const lines: string[] = [];
    const allModelIds = new Set<string>();
    for (const provider of providers) {
      const candidates = byProvider.get(provider)!;
      for (const m of candidates) allModelIds.add(m.slug);
      const fast = candidates.filter(m => hasTag(m, 'fast')).sort(rank);
      const rest = candidates.filter(m => !hasTag(m, 'fast')).sort(rank);
      // Up to 3 concrete picks per provider -- fastest first (if any), then the strongest general options.
      // Kept short deliberately ("do it super simple"): a compact, scannable menu beats a giant model-id dump.
      const top = [...fast.slice(0, 1), ...rest.slice(0, 2)];
      lines.push(`${provider}: ${top.map(m => m.slug).join(', ')}`);
    }
    return { providers, menuText: lines.join(' | '), allModelIds };
  } catch {
    // Cold-start catalog hiccup shouldn't take down the whole delegate tool's schema --
    // fall back to the same provider families the tool's description always used to
    // name in prose, just without concrete model ids (resolveModelIdForProvider still
    // works normally at real call time; this fallback only affects the enum/menu, and
    // an empty allModelIds means the agent.ts caller's own validation step is skipped
    // entirely on a cold-start hiccup, rather than wrongly rejecting everything).
    return { providers: FALLBACK_PROVIDERS, menuText: FALLBACK_PROVIDERS.join(', '), allModelIds: new Set() };
  }
}

