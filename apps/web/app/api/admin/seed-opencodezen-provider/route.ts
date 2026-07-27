/**
 * One-off admin seed: provisions the "Opencode Zen" shared/platform
 * provider (owner ask 2026-07-27 -- "wire hy3, grok-4.5, kimi-k3,
 * mimo-v2-pro only, same as free and hncsec, use the same $10 usage cap
 * for pricing"), restricted to EXACTLY those 4 models, nothing else from
 * Opencode Zen's much larger catalog (it also serves glm-5, deepseek-v4,
 * qwen3.7, minimax-m3 -- deliberately excluded, owner asked for these 4
 * only).
 *
 * Idempotent (safe to POST more than once): upserts by baseUrl+label for
 * the provider, by (providerId, modelId) for its models, and by
 * (modelPattern, effectiveFrom) for the rate rows -- exact same pattern as
 * seed-shared-provider (HCNSec) and seed-freemodel-provider (freemodel.dev).
 * Bearer ADMIN_DEBUG_TOKEN only, same as every other one-off admin diag route.
 *
 * Compatibility mode is OPENAI -- confirmed live 2026-07-27 by hitting
 * /v1/models and /v1/chat/completions directly: standard OpenAI Chat
 * Completions shape (streaming SSE `choices[].delta`, `tool_calls`,
 * `reasoning_content` field for thinking traces, usage object with
 * cached_tokens/reasoning_tokens sub-fields).
 *
 * isShared: true + no per-row spendCapUsd override -- draws from the SAME
 * combined SHARED_MONTHLY_CAP_USD ($10/mo) pool as HCNSec and
 * freemodel.dev (packages/db/src/usage-metering.ts's getAllSharedSpendUsd
 * sums every `provider LIKE 'shared:%'` row together, no per-provider cap
 * enforced anymore -- see that file's own comments). This is what "use the
 * same $10 usage [cap] for all the model pricing" means in practice: these
 * 4 models bill against the exact same pool, not a separate one.
 *
 * PRICING -- Opencode Zen's own API reports `"cost":"0"` on every response
 * (confirmed live, all 4 models), but CHECKED (2026-07-27, before
 * assuming that means free): direct/chat/route.ts's recordUsageEvent call
 * never passes providerReportedCostUsd for ANY provider today -- that
 * field exists on RecordUsageArgs but has zero real call sites yet, so a
 * provider's own self-reported cost is never actually read, here or
 * anywhere else. That means the rates below are NOT purely informational
 * the way this comment originally assumed -- they ARE what prices both
 * faceValueUsd and (since this is a `shared:*` provider, not BYOK)
 * actualCostUsd too, so real usage through these 4 models genuinely draws
 * down the same combined $10 pool as HCNSec/freemodel.dev, same as if
 * Opencode Zen billed us directly. Priced against each model's real
 * vendor-published rate (not Opencode Zen's own $0), same "price the real
 * backend, not the aggregator's marketing number" rule as HCNSec above.
 *
 * RESEARCHED LIVE (2026-07-27, owner ask: "search for the four pricing and
 * do it well" -- replacing the earlier same-magnitude guesses below with
 * real vendor-sourced rates):
 *
 *   requested alias  -> real backend + rate                        input / output / cache-read per MTok   source
 *   hy3               -> Tencent Hunyuan 3                          $0.14 / $0.56 / --                     atlascloud.ai + Tencent's own CNY rate (¥1.2/¥4 per 1M, tokenplan.vip) converge on this; NOT the cheaper "HY3 Preview" tier some aggregators quote ($0.063/$0.21) -- this is the full model actually served
 *   grok-4.5          -> xAI Grok 4.5                               $2.00 / $6.00 / $0.30                  docs.x.ai/developers/pricing (xAI's own page) + confirmed independently by OpenRouter, benchlm.ai, mindstudio.ai -- all agree exactly
 *   kimi-k3           -> Moonshot Kimi K3                            $3.00 / $15.00 / $0.30                 platform.kimi.ai/docs/pricing/chat-k3 (Moonshot's own docs) + OpenRouter, Verdent, Wavect, eesel.ai -- unanimous across 5+ independent sources
 *   mimo-v2-pro       -> Xiaomi MiMo v2 Pro                          $0.435 / $0.87 / $0.0036               pi.dev/models/xiaomi/mimo-v2-pro -- most granular/marketplace-style listing found; other aggregators disagreed wildly ($1/$3 flat guess vs a vague "$6.25/MTok" on Xiaomi's own landing page with no input/output split), this was the only source with real per-token-type precision. Still UNPRICED below anyway -- see next paragraph, the model doesn't work right now regardless of its rate card.
 *
 * mimo-v2-pro: CONFIRMED BROKEN (2026-07-27 live test, 10/10 requests over
 * a 7-minute stress run all returned HTTP 500 "Internal server error",
 * zero successes) -- included anyway per explicit owner request ("wired
 * ... Mimo v2 pro only"), isEnabled true so it still shows in the picker,
 * but left unpriced (no real successful call to price against yet) and
 * lastTestStatus/lastTestError set up front so the Settings page shows the
 * real problem instead of silently looking untested. Re-run this seed (or
 * the per-model "Test connection" button) once Opencode Zen fixes it
 * server-side to pick up pricing + clear the error.
 */
import { prisma } from '@entry/db';
import { encryptApiKey } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

const PROVIDER_LABEL = 'Opencode Zen';
const SPEND_CAP_USD = 10; // legacy/informational only, same as HCNSec/freemodel.dev -- real enforcement is the combined SHARED_MONTHLY_CAP_USD in usage-metering.ts

const MODELS: Array<{
  modelId: string;
  displayLabel: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  priced: boolean;
  lastTestStatus?: string;
  lastTestError?: string;
}> = [
  { modelId: 'hy3', displayLabel: 'Hunyuan 3', inputPerMTok: 0.14, outputPerMTok: 0.56, priced: true },
  { modelId: 'grok-4.5', displayLabel: 'Grok 4.5', inputPerMTok: 2.0, outputPerMTok: 6.0, cacheReadPerMTok: 0.3, priced: true },
  { modelId: 'kimi-k3', displayLabel: 'Kimi K3', inputPerMTok: 3.0, outputPerMTok: 15.0, cacheReadPerMTok: 0.3, priced: true },
  {
    modelId: 'mimo-v2-pro',
    displayLabel: 'MiMo v2 Pro',
    inputPerMTok: 0.435,
    outputPerMTok: 0.87,
    cacheReadPerMTok: 0.0036,
    priced: false,
    lastTestStatus: 'error',
    lastTestError: 'HTTP 500 Internal server error on every call (confirmed live 2026-07-27, 10/10 requests over a 7-minute test) -- broken on Opencode Zen\u2019s side, not an Entry-side config issue. Real market rate ($0.435/$0.87/MTok, pi.dev) is recorded above for reference but priced:false so it never actually bills until a real successful call exists to justify it.',
  },
];

export async function POST(req: Request) {
  if (!isAdminBearerAuthorized(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const baseUrl = process.env.OPENCODEZEN_BASE_URL;
  const apiKey = process.env.OPENCODEZEN_API_KEY;
  if (!baseUrl || !apiKey) {
    return Response.json({ error: 'OPENCODEZEN_BASE_URL / OPENCODEZEN_API_KEY not set in this environment' }, { status: 500 });
  }

  const adminFeature = await prisma.userFeature.findFirst({ where: { name: 'administrator', activated: true } });
  if (!adminFeature) {
    return Response.json({ error: 'No admin user found to own the shared provider row' }, { status: 500 });
  }
  const ownerId = adminFeature.userId;

  const existingProvider = await prisma.userModelProvider.findFirst({ where: { baseUrl, isShared: true } });
  const provider = existingProvider
    ? await prisma.userModelProvider.update({
        where: { id: existingProvider.id },
        data: {
          encryptedApiKey: encryptApiKey(apiKey),
          isShared: true,
          spendCapUsd: SPEND_CAP_USD,
          compatibility: 'OPENAI',
          lastError: null,
        },
      })
    : await prisma.userModelProvider.create({
        data: {
          userId: ownerId,
          label: PROVIDER_LABEL,
          compatibility: 'OPENAI',
          baseUrl,
          encryptedApiKey: encryptApiKey(apiKey),
          isShared: true,
          spendCapUsd: SPEND_CAP_USD,
        },
      });

  // Any model row on this provider NOT in the owner's exact 4-model list
  // gets disabled (never deleted) so the picker only ever shows the
  // requested set, even though Opencode Zen's real catalog has many more
  // models available on this same key (glm-5, deepseek-v4-*, qwen3.7-*,
  // minimax-m3, etc. -- all confirmed working live 2026-07-27 but not
  // requested).
  const allowedIds = new Set<string>(MODELS.map(m => m.modelId));
  const existingRows = await prisma.userModelProviderModel.findMany({ where: { providerId: provider.id } });
  for (const row of existingRows) {
    if (!allowedIds.has(row.modelId) && row.isEnabled) {
      await prisma.userModelProviderModel.update({ where: { id: row.id }, data: { isEnabled: false } });
    }
  }

  const modelResults: Array<{ modelId: string; modelRowId: string; priced: boolean }> = [];
  for (const m of MODELS) {
    const existing = await prisma.userModelProviderModel.findFirst({
      where: { providerId: provider.id, modelId: m.modelId },
    });
    // reasoningEnabled: true -- same one-time product decision as HCNSec/
    // freemodel.dev: shared, platform-picked models default to thinking ON.
    const data = {
      label: m.displayLabel,
      isEnabled: true,
      reasoningEnabled: true,
      ...(m.lastTestStatus ? { lastTestStatus: m.lastTestStatus, lastTestError: m.lastTestError, lastTestedAt: new Date() } : {}),
    };
    const row = existing
      ? await prisma.userModelProviderModel.update({ where: { id: existing.id }, data })
      : await prisma.userModelProviderModel.create({ data: { providerId: provider.id, modelId: m.modelId, ...data } });

    if (m.priced) {
      const effectiveFrom = new Date('2026-07-27T00:00:00Z');
      const existingRate = await prisma.modelPriceRate.findFirst({
        where: { modelPattern: m.modelId, effectiveFrom },
      });
      const rateData = {
        inputPerMTok: m.inputPerMTok,
        outputPerMTok: m.outputPerMTok,
        cacheWritePerMTok: 0,
        cacheReadPerMTok: m.cacheReadPerMTok ?? 0,
      };
      if (existingRate) {
        await prisma.modelPriceRate.update({ where: { id: existingRate.id }, data: rateData });
      } else {
        await prisma.modelPriceRate.create({ data: { modelPattern: m.modelId, effectiveFrom, ...rateData } });
      }
    }
    modelResults.push({ modelId: m.modelId, modelRowId: row.id, priced: m.priced });
  }

  return Response.json({
    ok: true,
    providerId: provider.id,
    providerLabel: provider.label,
    spendCapUsd: SPEND_CAP_USD,
    models: modelResults,
    note: 'mimo-v2-pro is confirmed broken upstream (HTTP 500) as of 2026-07-27 -- enabled per explicit request but will error in chat until Opencode Zen fixes it.',
  });
}
