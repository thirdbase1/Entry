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
  /** True only for OPENAI_RESPONSES-compatibility providers whose baseUrl is
   *  NOT the real OpenAI API (e.g. Kie.ai's grok/v1/responses relay). See
   *  direct/chat/route.ts's use of this flag for the actual bug it fixes:
   *  these third-party relays echo back a reasoning item `id` (and, unlike
   *  real OpenAI, no `encrypted_content`) exactly like OpenAI's own API
   *  shape, which fools @ai-sdk/openai's responses() input converter into
   *  emitting a stateful `item_reference`/dangling-id reasoning item on the
   *  NEXT turn — something only real OpenAI can actually resolve server-side.
   *  A relay that has no such server-side item store (confirmed against
   *  Kie.ai directly: identical grok-4.5 call one turn after a successful
   *  one comes back with finishReason 'other' and completely empty/
   *  undefined usage, no thrown error at all) just silently produces an
   *  empty completion instead of erroring, which read exactly like the
   *  model "stopping instantly" after a tool call. */
  isThirdPartyResponsesRelay: boolean;
  /** FIXED (2026-07-19, real log spam traced live: a 'Free' provider on
   *  ANTHROPIC compatibility mode, model id "claude-fable-5" — clearly a
   *  third-party relay, not real Anthropic — produced 80+ "unsupported
   *  reasoning metadata" warnings on a single turn, one per historical
   *  `reasoning` part in the compacted history). Root cause, confirmed in
   *  node_modules/@ai-sdk/anthropic/src/convert-to-anthropic-prompt.ts:
   *  every past `reasoning` part gets resent to Anthropic's Messages API
   *  as a `thinking`/`redacted_thinking` block ONLY if it carries a real
   *  `providerOptions.anthropic.signature` or `.redactedData` — fields
   *  only genuine Anthropic-issued thinking blocks have. A third-party
   *  relay merely returning plain reasoning text (no real signature) has
   *  every one of its past reasoning parts silently dropped with a
   *  warning EVERY single turn, forever, for the life of that chat —
   *  same root problem class as isThirdPartyResponsesRelay above (a relay
   *  imitating a real provider's API shape without that provider's actual
   *  stateful/signed reasoning-replay mechanism), just on the ANTHROPIC
   *  compatibility mode instead of OPENAI_RESPONSES. Same fix applies:
   *  never resend a previous turn's reasoning to a relay that can't
   *  actually replay it — see strip-reasoning-parts.ts. */
  isThirdPartyAnthropicRelay: boolean;
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
  let apiKey: string | undefined;
  if (provider.encryptedApiKey) {
    try {
      apiKey = decryptApiKey(provider.encryptedApiKey);
    } catch (err) {
      // FIXED (2026-07-20, real incident: BYOK_ENCRYPTION_KEY got rotated
      // in production, instantly bricking every saved BYOK provider with a
      // raw, opaque "Unsupported state or unable to authenticate data"
      // crypto crash on every single turn). A decrypt failure here always
      // means the stored ciphertext can no longer be read with whatever
      // key is currently configured — surface a clear, actionable message
      // instead of the raw crypto internals, and never crash the route for
      // an otherwise-recoverable per-provider problem (user just needs to
      // re-enter the key in Settings).
      throw new Error(
        `Your saved API key for "${provider.label}" could not be read (likely re-encrypted with a different server key) — please re-enter it in Settings > Providers.`
      );
    }
  }

  // Shared with the settings page's "Test connection" route
  // (build-model-client.ts) -- identical construction either way, just
  // extracted so testing a model doesn't require it to already be
  // isEnabled / looked up the way this function's signature demands.
  const model: LanguageModel = buildModelClient(
    { label: provider.label, compatibility: provider.compatibility, baseUrl: provider.baseUrl, apiKey },
    modelRow.modelId,
    { userId }
  );

  const isThirdPartyResponsesRelay =
    provider.compatibility === 'OPENAI_RESPONSES' &&
    !/(^|\.)api\.openai\.com$/.test(new URL(provider.baseUrl).hostname);

  const isThirdPartyAnthropicRelay =
    provider.compatibility === 'ANTHROPIC' &&
    !/(^|\.)api\.anthropic\.com$/.test(new URL(provider.baseUrl).hostname);

  return {
    model,
    providerLabel: provider.label,
    modelId: modelRow.modelId,
    reasoningEnabled: modelRow.reasoningEnabled,
    isThirdPartyResponsesRelay,
    isThirdPartyAnthropicRelay,
  };
}
