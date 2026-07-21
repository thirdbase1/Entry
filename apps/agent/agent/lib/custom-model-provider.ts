/**
 * ADDED (2026-07-18, "it can also specify... e.g. provider aerolink,
 * model gpt-5.6-sol" -- a user's own saved custom/BYOK provider, NOT a
 * Vercel AI Gateway family): the delegate tool (tool-impls/agent.ts)
 * previously could only ever target the public Gateway catalog
 * (anthropic/google/openai/...). A user can already register an
 * arbitrary custom OpenAI-compatible endpoint from the settings page
 * ("Add Provider" -- packages/db's `UserModelProvider` +
 * `UserModelProviderModel`, e.g. a third-party relay like
 * "aerolink" at its own base URL with its own API key and model ids).
 * That system already existed for the chat model-picker; this file is
 * what lets the delegate tool ALSO reach it, so "provider: aerolink,
 * model: gpt-5.6-sol" on an `agent` tool call resolves to the SAME real
 * connection the user already set up in settings -- their own base URL,
 * their own key, their own registered model id -- not a Gateway lookup.
 *
 * Deliberately self-contained rather than importing
 * apps/web/lib/byok/build-model-client.ts directly: that file lives
 * inside the apps/web Next app's own `lib/`, not a shared `packages/*`
 * workspace package, so it isn't a safe cross-app import target (eve's
 * own bundler for apps/agent has no guaranteed resolution path into a
 * sibling app's private `lib/`). The actual client-construction switch
 * below is intentionally a 1:1 port of that file's `buildModelClient`,
 * kept in sync by hand since both are small and change rarely.
 */
import type { LanguageModel } from 'ai';
import { prisma, decryptApiKey } from '@entry/db';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

export interface ResolvedCustomProviderModel {
  model: LanguageModel;
  providerLabel: string;
  modelId: string;
}

interface ProviderConnection {
  label: string;
  compatibility: string;
  baseUrl: string;
  apiKey: string | undefined;
}

async function buildCustomModelClient(provider: ProviderConnection, modelId: string): Promise<LanguageModel> {
  switch (provider.compatibility) {
    case 'ANTHROPIC': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ baseURL: provider.baseUrl, apiKey: provider.apiKey })(modelId);
    }
    case 'GOOGLE': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ baseURL: provider.baseUrl, apiKey: provider.apiKey })(modelId);
    }
    case 'OPENAI_RESPONSES': {
      // `apiKey ?? ''` (never undefined) -- same @ai-sdk/openai env-fallback
      // footgun apps/web/lib/byok/resolve-model.ts's identical case avoids.
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ baseURL: provider.baseUrl, apiKey: provider.apiKey ?? '' }).responses(modelId);
    }
    case 'OPENAI':
    default: {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      return createOpenAICompatible({ name: provider.label, baseURL: provider.baseUrl, apiKey: provider.apiKey })(modelId);
    }
  }
}

/**
 * Looks up one of the CALLING USER's own saved custom providers by label
 * (case-insensitive -- a tool-calling model shouldn't need to match exact
 * casing) and, optionally, one specific registered model id under it. When
 * `modelId` is omitted, auto-picks that provider's first enabled model --
 * mirrors the Gateway path's own "provider without model auto-picks" UX,
 * since a calling model can't be expected to already know the exact slug
 * a user happened to register a custom model under.
 *
 * Ownership-scoped: `userId` must match, same guard resolveByokModel.ts
 * already enforces for the direct-chat path -- a provider or model
 * belonging to a different user is never matched here.
 *
 * Returns null (never throws) on no match -- the caller decides how to
 * report that; a missing custom provider isn't necessarily an error; it
 * might just mean `provider` was meant as a Gateway family name instead.
 */
export async function resolveUserCustomProviderModel(
  userId: string,
  providerLabel: string,
  modelId?: string
): Promise<ResolvedCustomProviderModel | null> {
  const provider = await prisma.userModelProvider.findFirst({
    where: { userId, label: { equals: providerLabel, mode: 'insensitive' } },
  });
  if (!provider) return null;

  const modelRow = modelId
    ? await prisma.userModelProviderModel.findFirst({ where: { providerId: provider.id, modelId, isEnabled: true } })
    : await prisma.userModelProviderModel.findFirst({ where: { providerId: provider.id, isEnabled: true }, orderBy: { createdAt: 'asc' } });
  if (!modelRow) return null;

  let apiKey: string | undefined;
  if (provider.encryptedApiKey) {
    try {
      apiKey = decryptApiKey(provider.encryptedApiKey);
    } catch (err) {
      // See resolve-model.ts's identical 2026-07-20 fix comment — same
      // BYOK_ENCRYPTION_KEY-rotation incident, same fix (clear message,
      // never a raw crypto crash) for the sub-agent delegate path.
      throw new Error(
        `Your saved API key for "${provider.label}" could not be read (likely re-encrypted with a different server key) — please re-enter it in Settings > Providers.`
      );
    }
  }
  const model = await buildCustomModelClient(
    { label: provider.label, compatibility: provider.compatibility, baseUrl: provider.baseUrl, apiKey },
    modelRow.modelId
  );
  return { model, providerLabel: provider.label, modelId: modelRow.modelId };
}

/** Every custom provider label this user has saved -- for error messages guiding a bad guess toward real options. */
export async function listUserCustomProviderLabels(userId: string): Promise<string[]> {
  const rows = await prisma.userModelProvider.findMany({ where: { userId }, select: { label: true } });
  return rows.map(r => r.label);
}
