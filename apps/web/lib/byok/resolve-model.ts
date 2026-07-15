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
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { prisma, decryptApiKey } from '@entry/db';
import { createGatewayRetryFetch } from './gateway-retry-fetch';

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

  let model: LanguageModel;
  switch (provider.compatibility) {
    case 'ANTHROPIC':
      model = createAnthropic({ baseURL: provider.baseUrl, apiKey })(modelRow.modelId);
      break;
    case 'GOOGLE':
      model = createGoogleGenerativeAI({ baseURL: provider.baseUrl, apiKey })(modelRow.modelId);
      break;
    case 'OPENAI_RESPONSES':
      // OpenAI *Responses* API shape (input/output items, streamed as
      // `response.*` SSE events) -- NOT the Chat Completions shape the
      // OPENAI case below speaks. This is what aggregators proxying
      // Kie.ai-style per-model-family endpoints actually implement (e.g.
      // `POST https://api.kie.ai/grok/v1/responses` for their Grok 4.5).
      // `.responses(modelId)` on the official OpenAI provider appends
      // exactly `/responses` to whatever baseURL is configured, so the
      // user's saved baseUrl must already include the family segment +
      // `/v1` (`https://api.kie.ai/grok/v1`) -- see normalize-base-url.ts.
      // `apiKey ?? ''` (never leave it `undefined`) -- @ai-sdk/openai's
      // `loadApiKey()` silently falls back to reading `process.env.OPENAI_API_KEY`
      // whenever `apiKey` is `undefined`. This connection is a per-user BYOK
      // row that may legitimately have no key saved; it must never fall
      // through to any ambient/shared key the deployment happens to have set
      // for something else. An empty string still hits `typeof apiKey ===
      // 'string'` in loadApiKey and is returned as-is (matching this
      // connection's actual saved state), so a truly keyless upstream just
      // 401s on `Authorization: Bearer ` like it should.
      model = createOpenAI({ baseURL: provider.baseUrl, apiKey: apiKey ?? '' }).responses(modelRow.modelId);
      break;
    case 'OPENAI':
    default:
      // `fetch` override retries a confirmed transient gateway bug seen on
      // at least one real OpenAI-compatible relay (2026-07-11 user report,
      // "Function id ... is not found" 404) -- see that file's comment for
      // why this is safe (only retries an exact known-transient pattern,
      // every other 404 passes through untouched).
      model = createOpenAICompatible({ name: provider.label, baseURL: provider.baseUrl, apiKey, fetch: createGatewayRetryFetch() })(modelRow.modelId);
      break;
  }

  return { model, providerLabel: provider.label, modelId: modelRow.modelId, reasoningEnabled: modelRow.reasoningEnabled };
}
