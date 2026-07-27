/**
 * One-off admin seed: provisions the "HCNSec Relay" shared/platform
 * provider (owner ask 2026-07-26 — a relay key the platform pays for,
 * shown to every user, capped at $20 total spend) plus the
 * ModelPriceRate rows needed to price it accurately.
 *
 * Idempotent (safe to POST more than once): upserts by baseUrl+label for
 * the provider, by (providerId, modelId) for its models, and by
 * (modelPattern, effectiveFrom) for the rate rows. Bearer ADMIN_DEBUG_TOKEN
 * only, same as every other one-off admin diag route.
 *
 * IMPORTANT — pricing methodology, read before touching this file:
 * this relay (api.hcnsec.cn) mislabels several of its own models. Manual
 * testing (2026-07-26) against every model it advertises found the
 * *actual* serving backend (from each response's own `model` field) does
 * not always match the requested alias:
 *
 *   requested alias            -> ACTUAL backend that served it
 *   DeepSeek-V4-Pro             -> nvidia/nemotron-3-ultra-550b-a55b (NOT real DeepSeek)
 *   DeepSeek-V4-Flash           -> deepseek-ai/deepseek-v4-flash (honest — real DeepSeek)
 *   Kimi-K2.6                   -> thinkingmachines/inkling (NOT real Kimi/Moonshot)
 *   MiniMax-M2.7                -> minimaxai/minimax-m2.7 (honest)
 *   MiniMax-M3                  -> minimaxai/minimax-m3 (honest)
 *   Qwen3.6-35B-A3B             -> garbled backend id, treated as real Qwen3.6-35B-A3B
 *   sensenova-6.7-flash-lite    -> sensenova-6.7-flash-lite (honest, but NO public price found — left UNPRICED on purpose)
 *   step-3.7-flash              -> stepfun-ai/step-3.7-flash (honest)
 *
 * Excluded entirely (confirmed broken, not offered as selectable models):
 * glm-5.2 (persistent request timeout), Qwen3.5-397B-A17B (HTTP 410 Gone),
 * sensenova-u1-fast (HTTP 404 Not Found).
 *
 * Per admin.md §2's "capture, don't estimate" rule, every rate below is
 * priced against the model that ACTUALLY answered (verified live against
 * each vendor's own published pricing page 2026-07-26), never the
 * marketing alias — so the $ figure billed against the $20 cap is real,
 * even though the model LABEL a user picks says "DeepSeek-V4-Pro".
 */
import { prisma } from '@entry/db';
import { encryptApiKey } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

const PROVIDER_LABEL = 'HCNSec Relay';
const SPEND_CAP_USD = 10; // legacy/informational only (2026-07-27): real enforcement now uses the combined SHARED_MONTHLY_CAP_USD in usage-metering.ts, not this per-row field

// modelPattern here is the ALIAS (what the model picker/chat actually
// sends as `model`), but the per-1M rates are the REAL backend model's
// official published price — see file comment above.
const MODELS: Array<{
  alias: string;
  displayLabel: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok?: number;
  cacheReadPerMTok?: number;
  priced: boolean;
}> = [
  { alias: 'DeepSeek-V4-Pro', displayLabel: 'DeepSeek-V4-Pro (routes to Nemotron 3 Ultra)', inputPerMTok: 0.8, outputPerMTok: 2.6, priced: true },
  { alias: 'DeepSeek-V4-Flash', displayLabel: 'DeepSeek-V4-Flash', inputPerMTok: 0.14, cacheReadPerMTok: 0.0028, outputPerMTok: 0.28, priced: true },
  { alias: 'Kimi-K2.6', displayLabel: 'Kimi-K2.6 (routes to Inkling)', inputPerMTok: 3.74, cacheReadPerMTok: 0.748, outputPerMTok: 9.36, priced: true },
  { alias: 'MiniMax-M2.7', displayLabel: 'MiniMax-M2.7', inputPerMTok: 0.3, outputPerMTok: 1.2, priced: true },
  { alias: 'MiniMax-M3', displayLabel: 'MiniMax-M3', inputPerMTok: 0.45, outputPerMTok: 1.8, priced: true },
  { alias: 'Qwen3.6-35B-A3B', displayLabel: 'Qwen3.6-35B-A3B', inputPerMTok: 0.248, outputPerMTok: 1.485, priced: true },
  { alias: 'sensenova-6.7-flash-lite', displayLabel: 'SenseNova 6.7 Flash-Lite (no public price found — unpriced)', inputPerMTok: 0, outputPerMTok: 0, priced: false },
  { alias: 'step-3.7-flash', displayLabel: 'Step 3.7 Flash', inputPerMTok: 0.2, cacheReadPerMTok: 0.04, outputPerMTok: 1.15, priced: true },
];

export async function POST(req: Request) {
  if (!isAdminBearerAuthorized(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const baseUrl = process.env.HCNSEC_BASE_URL;
  const apiKey = process.env.HCNSEC_API_KEY;
  if (!baseUrl || !apiKey) {
    return Response.json({ error: 'HCNSEC_BASE_URL / HCNSEC_API_KEY not set in this environment' }, { status: 500 });
  }

  // Any admin user works as the required owning FK — isShared=true is
  // what actually makes this visible to everyone (see schema.prisma).
  const adminFeature = await prisma.userFeature.findFirst({ where: { name: 'administrator', activated: true } });
  if (!adminFeature) {
    return Response.json({ error: 'No admin user found to own the shared provider row' }, { status: 500 });
  }
  const ownerId = adminFeature.userId;

  // No natural unique constraint on (baseUrl,label) exists yet — find
  // first, then create-or-update explicitly, so re-running this is a
  // no-op update rather than creating duplicate provider rows.
  const existingProvider = await prisma.userModelProvider.findFirst({ where: { baseUrl, isShared: true } });
  const provider = existingProvider
    ? await prisma.userModelProvider.update({
        where: { id: existingProvider.id },
        data: {
          encryptedApiKey: encryptApiKey(apiKey),
          isShared: true,
          spendCapUsd: SPEND_CAP_USD,
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

  const modelResults: Array<{ alias: string; modelRowId: string; priced: boolean }> = [];
  for (const m of MODELS) {
    const existing = await prisma.userModelProviderModel.findFirst({
      where: { providerId: provider.id, modelId: m.alias },
    });
    // reasoningEnabled: true -- owner ask 2026-07-26: "make sure all
    // hncsec model thinking mode is enabled by default". These are shared,
    // platform-picked models (not a user's own BYOK key), so defaulting
    // thinking ON for all of them is a one-time product decision made
    // here at seed time, not something the end user has to opt into per
    // model.
    const row = existing
      ? await prisma.userModelProviderModel.update({
          where: { id: existing.id },
          data: { label: m.displayLabel, isEnabled: true, reasoningEnabled: true },
        })
      : await prisma.userModelProviderModel.create({
          data: { providerId: provider.id, modelId: m.alias, label: m.displayLabel, isEnabled: true, reasoningEnabled: true },
        });

    if (m.priced) {
      const effectiveFrom = new Date('2026-07-26T00:00:00Z');
      const existingRate = await prisma.modelPriceRate.findFirst({
        where: { modelPattern: m.alias, effectiveFrom },
      });
      if (existingRate) {
        await prisma.modelPriceRate.update({
          where: { id: existingRate.id },
          data: {
            inputPerMTok: m.inputPerMTok,
            outputPerMTok: m.outputPerMTok,
            cacheWritePerMTok: m.cacheWritePerMTok ?? 0,
            cacheReadPerMTok: m.cacheReadPerMTok ?? 0,
          },
        });
      } else {
        await prisma.modelPriceRate.create({
          data: {
            modelPattern: m.alias,
            effectiveFrom,
            inputPerMTok: m.inputPerMTok,
            outputPerMTok: m.outputPerMTok,
            cacheWritePerMTok: m.cacheWritePerMTok ?? 0,
            cacheReadPerMTok: m.cacheReadPerMTok ?? 0,
          },
        });
      }
    }
    modelResults.push({ alias: m.alias, modelRowId: row.id, priced: m.priced });
  }

  return Response.json({
    ok: true,
    providerId: provider.id,
    providerLabel: provider.label,
    spendCapUsd: SPEND_CAP_USD,
    models: modelResults,
  });
}
