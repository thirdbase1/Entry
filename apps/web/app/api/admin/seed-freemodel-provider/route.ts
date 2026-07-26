/**
 * One-off admin seed: provisions the "freemodel.dev" shared/platform
 * provider (owner ask 2026-07-27 -- "Add this provider same way you
 * added hncsec"), restricted to EXACTLY the 7 Claude models the owner
 * named, nothing else from freemodel.dev's much larger catalog.
 *
 * Idempotent (safe to POST more than once): upserts by baseUrl+label for
 * the provider, by (providerId, modelId) for its models, and by
 * (modelPattern, effectiveFrom) for the rate rows -- exact same pattern
 * as seed-shared-provider/route.ts (HCNSec). Bearer ADMIN_DEBUG_TOKEN
 * only, same as every other one-off admin diag route.
 *
 * Compatibility mode is ANTHROPIC, not OPENAI -- these are real Claude
 * model ids (claude-fable-5, claude-opus-4-6/4-7/4-8/5, claude-sonnet-
 * 4-6/5) served through a relay, matching the exact "claude-fable-5,
 * ANTHROPIC compatibility mode, clearly a third-party relay" case
 * byok/resolve-model.ts's isThirdPartyAnthropicRelay flag was built for.
 *
 * PRICING (verified live against Anthropic's own pricing/announcement
 * pages 2026-07-27 -- see seed-model-prices/route.ts's claude-* rows for
 * the exact same figures + sources, this route just points at them by
 * matching modelPattern === modelId since these aliases ARE the real
 * model ids, unlike HCNSec's mislabeled aliases):
 *   claude-fable-5      $10 / $50 per MTok (Mythos-class, NOT the same
 *                        model as Opus 5 despite the confusing naming --
 *                        confirmed via anthropic.com/news/claude-fable-5-mythos-5)
 *   claude-opus-5       $5  / $25 per MTok
 *   claude-opus-4-8     $5  / $25 per MTok
 *   claude-opus-4-7     $5  / $25 per MTok
 *   claude-opus-4-6     $5  / $25 per MTok
 *   claude-sonnet-4-6   $3  / $15 per MTok
 *   claude-sonnet-5     $2  / $10 per MTok (introductory, thru 2026-08-31,
 *                        then $3/$15 standard -- see seed-model-prices.ts)
 */
import { prisma } from '@entry/db';
import { encryptApiKey } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

const PROVIDER_LABEL = 'freemodel.dev';
// No cap was specified by the owner -- defaulting to the same $20
// pattern used for HCNSec (the only precedent this app has for a shared/
// platform-paid relay) since these Claude models bill at real, fairly
// high per-token rates. Easy to raise/remove later via Settings or a
// follow-up seed run -- flagged to the owner in the response body too.
const SPEND_CAP_USD = 20;

const MODELS = [
  { modelId: 'claude-fable-5', displayLabel: 'Claude Fable 5' },
  { modelId: 'claude-opus-4-6', displayLabel: 'Claude Opus 4.6' },
  { modelId: 'claude-opus-4-7', displayLabel: 'Claude Opus 4.7' },
  { modelId: 'claude-opus-4-8', displayLabel: 'Claude Opus 4.8' },
  { modelId: 'claude-opus-5', displayLabel: 'Claude Opus 5' },
  { modelId: 'claude-sonnet-4-6', displayLabel: 'Claude Sonnet 4.6' },
  { modelId: 'claude-sonnet-5', displayLabel: 'Claude Sonnet 5' },
] as const;

export async function POST(req: Request) {
  if (!isAdminBearerAuthorized(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const baseUrl = process.env.FREEMODEL_BASE_URL;
  const apiKey = process.env.FREEMODEL_API_KEY;
  if (!baseUrl || !apiKey) {
    return Response.json({ error: 'FREEMODEL_BASE_URL / FREEMODEL_API_KEY not set in this environment' }, { status: 500 });
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
          compatibility: 'ANTHROPIC',
          lastError: null,
        },
      })
    : await prisma.userModelProvider.create({
        data: {
          userId: ownerId,
          label: PROVIDER_LABEL,
          compatibility: 'ANTHROPIC',
          baseUrl,
          encryptedApiKey: encryptApiKey(apiKey),
          isShared: true,
          spendCapUsd: SPEND_CAP_USD,
        },
      });

  // Any model row on this provider NOT in the owner's exact 7-model list
  // gets disabled (never deleted -- keeps usage history intact) so the
  // picker only ever shows the requested set, even though freemodel.dev's
  // real catalog has many more models available on this same key.
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
    // reasoningEnabled: true -- same one-time product decision as HCNSec:
    // shared, platform-picked models default to thinking ON.
    const row = existing
      ? await prisma.userModelProviderModel.update({
          where: { id: existing.id },
          data: { label: m.displayLabel, isEnabled: true, reasoningEnabled: true },
        })
      : await prisma.userModelProviderModel.create({
          data: { providerId: provider.id, modelId: m.modelId, label: m.displayLabel, isEnabled: true, reasoningEnabled: true },
        });
    modelResults.push({ modelId: m.modelId, modelRowId: row.id });
  }

  return Response.json({
    ok: true,
    providerId: provider.id,
    providerLabel: provider.label,
    spendCapUsd: SPEND_CAP_USD,
    models: modelResults,
    note: 'Pricing comes from seed-model-prices (modelPattern === real modelId for all 7). Run that route too (or it is already run) to guarantee rates are live.',
  });
}
