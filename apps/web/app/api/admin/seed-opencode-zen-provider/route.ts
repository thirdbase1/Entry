/**
 * Idempotent admin seed for OpenCode Zen's free shared models.
 *
 * OpenCode Zen calls itself OpenCode Zen (not OpenZen) and exposes an
 * OpenAI-compatible endpoint. Free models still require an OpenCode Zen API
 * key, so the key must be configured as OPENCODE_ZEN_API_KEY; it must never
 * be confused with a GitHub token.
 */
import { prisma, encryptApiKey } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

const PROVIDER_LABEL = 'OpenCode Zen';
const BASE_URL = process.env.OPENCODE_ZEN_BASE_URL || 'https://opencode.ai/zen/v1';
const SPEND_CAP_USD = 0;
const EFFECTIVE_FROM = new Date('2026-08-05T00:00:00Z');

const FREE_MODELS = [
  { modelId: 'big-pickle', label: 'Big Pickle' },
  { modelId: 'deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free' },
  { modelId: 'mimo-v2.5-free', label: 'MiMo V2.5 Free' },
  { modelId: 'laguna-s-2.1-free', label: 'Laguna S 2.1 Free' },
  { modelId: 'ling-3.0-flash-free', label: 'Ling 3.0 Flash Free' },
  { modelId: 'longcat-2.0-free', label: 'LongCat 2.0 Free' },
  { modelId: 'north-mini-code-free', label: 'North Mini Code Free' },
  { modelId: 'nemotron-3-ultra-free', label: 'Nemotron 3 Ultra Free' },
] as const;

export async function POST(req: Request) {
  if (!isAdminBearerAuthorized(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const apiKey = process.env.OPENCODE_ZEN_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'OPENCODE_ZEN_API_KEY is not configured; add the OpenCode Zen key before seeding the shared provider.' }, { status: 500 });
  }

  const adminFeature = await prisma.userFeature.findFirst({ where: { name: 'administrator', activated: true } });
  if (!adminFeature) return Response.json({ error: 'No admin user found to own the shared provider row' }, { status: 500 });

  const existingProvider = await prisma.userModelProvider.findFirst({ where: { baseUrl: BASE_URL, isShared: true } });
  const provider = existingProvider
    ? await prisma.userModelProvider.update({
        where: { id: existingProvider.id },
        data: { encryptedApiKey: encryptApiKey(apiKey), label: PROVIDER_LABEL, compatibility: 'OPENAI', isShared: true, spendCapUsd: SPEND_CAP_USD, lastError: null },
      })
    : await prisma.userModelProvider.create({
        data: { userId: adminFeature.userId, label: PROVIDER_LABEL, compatibility: 'OPENAI', baseUrl: BASE_URL, encryptedApiKey: encryptApiKey(apiKey), isShared: true, spendCapUsd: SPEND_CAP_USD },
      });

  const allowedIds = new Set(FREE_MODELS.map(m => m.modelId));
  const existingModels = await prisma.userModelProviderModel.findMany({ where: { providerId: provider.id } });
  for (const row of existingModels) {
    if (!allowedIds.has(row.modelId) && row.isEnabled) {
      await prisma.userModelProviderModel.update({ where: { id: row.id }, data: { isEnabled: false } });
    }
  }

  const models: Array<{ modelId: string; modelRowId: string }> = [];
  for (const model of FREE_MODELS) {
    const existing = await prisma.userModelProviderModel.findFirst({ where: { providerId: provider.id, modelId: model.modelId } });
    const row = existing
      ? await prisma.userModelProviderModel.update({ where: { id: existing.id }, data: { label: model.label, isEnabled: true, reasoningEnabled: true } })
      : await prisma.userModelProviderModel.create({ data: { providerId: provider.id, modelId: model.modelId, label: model.label, isEnabled: true, reasoningEnabled: true } });
    models.push({ modelId: model.modelId, modelRowId: row.id });

    const existingRate = await prisma.modelPriceRate.findFirst({ where: { modelPattern: model.modelId, effectiveFrom: EFFECTIVE_FROM } });
    const rateData = { inputPerMTok: 0, outputPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0 };
    if (existingRate) await prisma.modelPriceRate.update({ where: { id: existingRate.id }, data: rateData });
    else await prisma.modelPriceRate.create({ data: { modelPattern: model.modelId, effectiveFrom: EFFECTIVE_FROM, ...rateData } });
  }

  return Response.json({ ok: true, providerId: provider.id, providerLabel: provider.label, baseUrl: BASE_URL, models });
}
