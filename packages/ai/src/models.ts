/**
 * Replaces the old STATIC `gatewayModels` array (which was a hand-copied
 * list of ~20 model ids/capabilities from the original's 8 vendor provider
 * classes). Per explicit instruction: no hardcoded model ids anywhere —
 * the catalog is fetched live from the Vercel AI Gateway
 * (`gateway.getAvailableModels()`, confirmed real via the installed
 * @ai-sdk/gateway's shipped .d.ts: `GatewayProvider#getAvailableModels():
 * Promise<{ models: GatewayLanguageModelEntry[] }>`) and cached with a TTL,
 * backed by packages/cache (Upstash/Redis) when available so every
 * instance/cold-start doesn't refetch, falling back to an in-process cache
 * otherwise.
 *
 * Honest limitation, not glossed over: the Gateway's metadata response
 * gives `id`, `name`, `description`, `pricing`, and a coarse `modelType`
 * (embedding | image | language | realtime | reranking | speech |
 * transcription | video) — it does NOT expose fine-grained per-model INPUT
 * modality (e.g. "does this language model accept image input"). The
 * original's hand-maintained capability arrays encoded that detail, but it
 * simply isn't published by this API. Two consequences, both handled
 * explicitly rather than silently faked:
 *   1. Capability filtering here matches on `modelType` → OUTPUT type only
 *      (language→Text/Object/Structured, embedding→Embedding, image→Image).
 *   2. INPUT type requirements (e.g. "needs image input") are NOT hard
 *      filters against this catalog — see `selectModel` in provider.ts for
 *      how an explicit `modelId` request still bypasses catalog filtering
 *      entirely (Gateway itself will error at call time if a truly
 *      incompatible model/input pair is sent, same escape hatch the
 *      original had).
 */
import { gateway } from './gateway';
import { ModelInputType, ModelOutputType, type CopilotProviderModel } from './types';

type MiniCache = { get: <T>(key: string) => Promise<T | undefined>; set: <T>(key: string, value: T, opts: { ttl?: number }) => Promise<boolean> };

let cacheModule: MiniCache | null | undefined;

/** Lazily/optionally wire packages/cache (Upstash) without making it a hard dependency of this package. */
async function getCache(): Promise<MiniCache | null> {
  if (cacheModule !== undefined) return cacheModule;
  try {
    // @ts-ignore — optional cross-package dep, resolved only if @entry/cache is installed in the consuming app.
    const mod = await import('@entry/cache');
    cacheModule = mod.cache ?? null;
  } catch {
    cacheModule = null;
  }
  return cacheModule;
}

const CATALOG_CACHE_KEY = 'gateway:model-catalog:v1';
const CATALOG_TTL_MS = 5 * 60 * 1000; // 5 min — short enough to pick up new Gateway models quickly, long enough to avoid refetching every call

let memCache: { fetchedAt: number; models: CopilotProviderModel[] } | null = null;

function modelTypeToCapabilities(modelType: string | null | undefined): CopilotProviderModel['capabilities'] {
  switch (modelType) {
    case 'embedding':
      return [{ input: [ModelInputType.Text], output: [ModelOutputType.Embedding] }];
    case 'image':
      return [{ input: [ModelInputType.Text], output: [ModelOutputType.Image] }];
    case 'language':
    case undefined:
    case null:
      // Default assumption for the common case (no modelType returned, or
      // explicitly 'language'): most current Gateway chat models support
      // structured/object output via the AI SDK's generateObject regardless
      // of vendor, and this catalog doesn't tell us otherwise per-model.
      return [{ input: [ModelInputType.Text], output: [ModelOutputType.Text, ModelOutputType.Object, ModelOutputType.Structured] }];
    default:
      // realtime / reranking / speech / transcription / video — not used by
      // any of our current tool call sites (text/structured/embedding/image),
      // so no capability mapping needed yet; extend here if a tool starts
      // using one of these output types.
      return [];
  }
}

/**
 * Fetch (or serve from cache) the live Gateway model catalog, mapped into
 * our internal `CopilotProviderModel[]` shape. This is the ONLY source of
 * model ids used anywhere in this package now.
 */
export async function getModelCatalog(): Promise<CopilotProviderModel[]> {
  if (memCache && Date.now() - memCache.fetchedAt < CATALOG_TTL_MS) {
    return memCache.models;
  }

  const cache = await getCache();
  if (cache) {
    const cached = await cache.get<CopilotProviderModel[]>(CATALOG_CACHE_KEY).catch(() => undefined);
    if (cached) {
      memCache = { fetchedAt: Date.now(), models: cached };
      return cached;
    }
  }

  const { models } = await gateway.getAvailableModels();
  const mapped: CopilotProviderModel[] = models.map(m => ({
    id: m.id,
    name: m.name,
    capabilities: modelTypeToCapabilities(m.modelType),
  }));

  memCache = { fetchedAt: Date.now(), models: mapped };
  if (cache) await cache.set(CATALOG_CACHE_KEY, mapped, { ttl: CATALOG_TTL_MS }).catch(() => false);
  return mapped;
}

/**
 * Non-Gateway exception, unchanged from the earlier hardcoded-list version:
 * Oracle/OCI is confirmed NOT in the Gateway's catalog (verified live, not
 * assumed) and was fully dropped — its one model (Grok-4 via OCI) is already
 * reachable directly through the Gateway's own `xai/*` ids, which now show
 * up automatically via `getModelCatalog()` above rather than needing a
 * manual entry.
 */
export const nonGatewayProviderNotes = {
  oracle: 'OCI Generative AI — confirmed NOT in the Vercel AI Gateway catalog; needs a direct client outside the Gateway if actually required, otherwise drop.',
} as const;
