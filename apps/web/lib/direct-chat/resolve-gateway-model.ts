/**
 * Resolves an explicit Gateway model-picker choice (e.g.
 * "anthropic/claude-opus-4.8" or "deepseek/deepseek-v4-pro") straight to a
 * Vercel AI Gateway `LanguageModel` — the Gateway counterpart to
 * lib/byok/resolve-model.ts's `resolveByokModel`. Both feed the same
 * unified direct-chat route (apps/web/app/api/direct/chat): whichever
 * model the user explicitly picked in chat-config.tsx IS the whole turn,
 * with no eve-root relay in front of it.
 */
import { gateway } from '@ai-sdk/gateway';
import type { LanguageModel } from 'ai';
import { inferModelFamily } from '@/lib/model-provider';

export interface ResolvedGatewayModel {
  model: LanguageModel;
  providerLabel: string;
  modelId: string;
}

/**
 * Model id substrings that are hard-incompatible with this app's chat --
 * see /api/server/models/route.ts's own INCOMPATIBLE_MODEL_ID_SUBSTRINGS
 * comment for the full story (Google's `antigravity-preview-*` family
 * rejects any multi-turn request with a 400, and every chat here is
 * inherently multi-turn). That catalog filter keeps it out of the picker
 * for NEW selections; this second check is defense-in-depth for a
 * session that already had it selected before the filter existed (a
 * stale client-side `requestedModel` in localStorage/URL/an existing
 * chat row), so it fails clearly and immediately here instead of
 * streaming an opaque Gateway 400 mid-turn.
 */
const INCOMPATIBLE_MODEL_ID_SUBSTRINGS = ['antigravity'];

export function resolveGatewayModel(slug: string): ResolvedGatewayModel {
  if (!slug || typeof slug !== 'string') {
    throw new Error('requestedModel is required.');
  }
  const lower = slug.toLowerCase();
  if (INCOMPATIBLE_MODEL_ID_SUBSTRINGS.some(bad => lower.includes(bad))) {
    throw new Error(`"${slug}" doesn't support ongoing conversations (Google restricts this preview model to a single exchange) — please pick a different model.`);
  }
  return {
    model: gateway(slug),
    providerLabel: inferModelFamily(slug),
    modelId: slug,
  };
}
