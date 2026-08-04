/**
 * One-off admin seed: provisions a SECOND, separate "Opencode Zen (Free
 * Tier)" shared/platform provider row (owner ask 2026-08-05 -- "Add this
 * and wired it as another shared provider... add only [these] model[s]...
 * this one usage is still tied to the shared [pool]"), restricted to
 * EXACTLY these 4 models: laguna-s-2.1-free, ling-3.0-flash-free,
 * deepseek-v4-flash-free, mimo-v2.5-free.
 *
 * Deliberately a SEPARATE provider row from the existing "Opencode Zen"
 * provider (see ../seed-opencodezen-provider/route.ts, which serves hy3,
 * grok-4.5, kimi-k3, mimo-v2-pro on a different key) even though both
 * point at the same https://opencode.ai/zen/v1 base URL -- the owner
 * supplied a distinct API key for this batch, and matching only on
 * baseUrl (like the original route does) would have collided the two
 * providers into one DB row and overwritten the original's key. This
 * route matches on (baseUrl, isShared, label) instead so the two provider
 * rows can never collide even though their baseUrl is identical.
 *
 * Base URL and API key are BOTH read from env (OPENCODEZEN_FREE_BASE_URL /
 * OPENCODEZEN_FREE_API_KEY) -- never hardcoded -- per owner ask "update
 * everything to the new url or make it dynamic". Defaults are not
 * assumed; the route 500s with a clear message if either is unset.
 *
 * isShared: true, no per-row spendCapUsd override beyond the same
 * legacy/informational SPEND_CAP_USD used elsewhere -- real enforcement
 * is the combined SHARED_MONTHLY_CAP_USD pool in usage-metering.ts
 * (getAllSharedSpendUsd sums every `provider LIKE 'shared:%'` row
 * together, scoped per-user). This is what "this one usage is still tied
 * to the shared" means in practice: these 4 models draw down the exact
 * same per-user $10/mo pool as every other shared provider, they are NOT
 * free/unlimited to the end user even though Opencode Zen itself charges
 * Entry $0 for them right now.
 *
 * Model selector display: displayLabel below is deliberately the plain
 * model name with NO "Free" wording (e.g. "Laguna S 2.1", not "Laguna S
 * 2.1 Free") per owner ask "make sure you don't show the free" -- these
 * are billed against the shared pool at their real vendor-published rate,
 * so labeling them "Free" in the UI would be actively misleading about
 * how usage is metered, even though the underlying id (e.g.
 * "laguna-s-2.1-free") keeps the "-free" suffix because that's Opencode
 * Zen's real model id and must match exactly for API calls to work.
 *
 * PRICING -- Opencode Zen's own docs (opencode.ai/docs/zen/) list all 4 of
 * these ids at literal $0/$0/$0 (their current promo), same situation as
 * the original 4-model seed: priced here against each model's real
 * vendor-published rate instead, researched live 2026-08-05:
 *
 *   model id                 -> real backend + rate                    input / output per MTok   source
 *   laguna-s-2.1-free         -> Poolside Laguna S 2.1                  $0.10 / $0.20              models.dev/models/poolside/laguna-s-2.1 (Poolside's own published non-promo rate across other providers)
 *   ling-3.0-flash-free       -> Ant Bailing Ling-3.0-flash              $1.00 / $3.20              llmtimeline.org's Ling-3.0-flash entry ("Priced at $1.00/$3.20 per million input/output tokens via API"); Ant's dev blog only publishes the older Ling-2.6-flash rate (¥ pricing), not this version
 *   deepseek-v4-flash-free     -> DeepSeek V4 Flash                      $0.14 / $0.28 (cache-read $0.028) -- opencode.ai/docs/zen/'s own paid-tier row for "DeepSeek V4 Flash" (no -free suffix) + confirmed independently via pi.dev and DeepSeek's own API pricing page
 *   mimo-v2.5-free             -> Xiaomi MiMo V2.5                       $0.14 / $0.28              opencode.ai/docs/go/ ("MiMo V2.5, $0.14, $0.28") + opencode.ai/data/xiaomi/mimo-v2.5 confirms the same input/output split
 *
 * All 4 confirmed reachable/working on this key as of seeding (owner
 * supplied a fresh key 2026-08-05) -- no broken-model caveat like the
 * original route's mimo-v2-pro entry.
 */
import { prisma } from '@entry/db';
import { encryptApiKey } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

const PROVIDER_LABEL = 'Opencode Zen (Free Tier)';
const SPEND_CAP_USD = 10; // legacy/informational only -- real enforcement is the combined SHARED_MONTHLY_CAP_USD in usage-metering.ts

const MODELS: Array<{
  modelId: string;
  displayLabel: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
}> = [
  { modelId: 'laguna-s-2.1-free', displayLabel: 'Laguna S 2.1', inputPerMTok: 0.10, outputPerMTok: 0.20 },
  { modelId: 'ling-3.0-flash-free', displayLabel: 'Ling 3.0 Flash', inputPerMTok: 1.00, outputPerMTok: 3.20 },
  { modelId: 'deepseek-v4-flash-free', displayLabel: 'DeepSeek V4 Flash', inputPerMTok: 0.14, outputPerMTok: 0.28, cacheReadPerMTok: 0.028 },
  { modelId: 'mimo-v2.5-free', displayLabel: 'MiMo V2.5', inputPerMTok: 0.14, outputPerMTok: 0.28 },
];

export async function POST(req: Request) {
  if (!isAdminBearerAuthorized(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const baseUrl = process.env.OPENCODEZEN_FREE_BASE_URL;
  const apiKey = process.env.OPENCODEZEN_FREE_API_KEY;
  if (!baseUrl || !apiKey) {
    return Response.json({ error: 'OPENCODEZEN_FREE_BASE_URL / OPENCODEZEN_FREE_API_KEY not set in this environment' }, { status: 500 });
  }

  const adminFeature = await prisma.userFeature.findFirst({ where: { name: 'administrator', activated: true } });
  if (!adminFeature) {
    return Response.json({ error: 'No admin user found to own the shared provider row' }, { status: 500 });
  }
  const ownerId = adminFeature.userId;

  // Matches on label too (not just baseUrl+isShared) so this never
  // collides with the original "Opencode Zen" provider row, which shares
  // the exact same baseUrl on a different key.
  const existingProvider = await prisma.userModelProvider.findFirst({ where: { baseUrl, isShared: true, label: PROVIDER_LABEL } });
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

  // Disable (never delete) any model row on this provider not in the
  // exact requested list, same pattern as the original seed route.
  const allowedIds = new Set<string>(MODELS.map(m => m.modelId));
  const existingRows = await prisma.userModelProviderModel.findMany({ where: { providerId: provider.id } });
  for (const row of existingRows) {
    if (!allowedIds.has(row.modelId) && row.isEnabled) {
      await prisma.userModelProviderModel.update({ where: { id: row.id }, data: { isEnabled: false } });
    }
  }

  const modelResults: Array<{ modelId: string; modelRowId: string }> = [];
  for (const m of MODELS) {
    const existing = await prisma.userModelProviderModel.findFirst({
      where: { providerId: provider.id, modelId: m.modelId },
    });
    const data = {
      label: m.displayLabel, // deliberately no "Free" wording -- see file comment
      isEnabled: true,
      reasoningEnabled: true,
    };
    const row = existing
      ? await prisma.userModelProviderModel.update({ where: { id: existing.id }, data })
      : await prisma.userModelProviderModel.create({ data: { providerId: provider.id, modelId: m.modelId, ...data } });

    const effectiveFrom = new Date('2026-08-05T00:00:00Z');
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

    modelResults.push({ modelId: m.modelId, modelRowId: row.id });
  }

  return Response.json({
    ok: true,
    providerId: provider.id,
    providerLabel: provider.label,
    spendCapUsd: SPEND_CAP_USD,
    models: modelResults,
  });
}
