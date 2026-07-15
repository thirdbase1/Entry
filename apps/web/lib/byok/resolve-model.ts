/**
 * Resolves a saved BYOK provider model row into a real, direct
 * `LanguageModel` — same construction run_model.ts already uses (and
 * already proven to never touch Vercel AI Gateway): a direct provider
 * client built from the user's own baseURL + decrypted key, talking
 * straight to their endpoint.
 *
 * This is the shared resolver for the fully-separate BYOK chat path
 * (/api/byok/chat), which never invokes eve's session/model runtime at
 * all for a BYOK-selected chat — see that route for why (eve's `model:`
 * is fixed once per deployment, so it cannot itself skip the shared root
 * model per-request; the only way to guarantee zero Gateway involvement
 * for a BYOK turn is to never hand the turn to eve in the first place).
 */
import type { LanguageModel } from 'ai';
import { prisma, decryptApiKey } from '@entry/db';
import { buildModelClient } from './build-model-client';

export interface ResolvedByokModel {
  model: LanguageModel;
  providerLabel: string;
  modelId: string;
  /** Manual per-model override of the reasoning-capability heuristic —
   *  see reasoning-capability.ts + the settings page's "Thinking" toggle. */
  reasoningEnabled: boolean;
}

/** Ownership-checked: a model row id alone is never sufficient — it must belong to userId. */
export async function resolveByokModel(byokModelId: string, userId: string): Promise<ResolvedByokModel> {
  const modelRow = await prisma.userModelProviderModel.findFirst({
    where: { id: byokModelId, isEnabled: true, provider: { userId } },
    include: { provider: true },
  });
  if (!modelRow) {
    throw new Error('BYOK model not found, disabled, or not owned by the current user.');
  }

  const { provider } = modelRow;
  const apiKey = provider.encryptedApiKey ? decryptApiKey(provider.encryptedApiKey) : undefined;

  // Shared with the settings page's "Test connection" route
  // (build-model-client.ts) -- identical construction either way, just
  // extracted so testing a model doesn't require it to already be
  // isEnabled / looked up the way this function's signature demands.
  const model: LanguageModel = buildModelClient(
    { label: provider.label, compatibility: provider.compatibility, baseUrl: provider.baseUrl, apiKey },
    modelRow.modelId
  );

  return { model, providerLabel: provider.label, modelId: modelRow.modelId, reasoningEnabled: modelRow.reasoningEnabled };
}
