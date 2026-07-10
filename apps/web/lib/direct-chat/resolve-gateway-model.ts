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

export function resolveGatewayModel(slug: string): ResolvedGatewayModel {
  if (!slug || typeof slug !== 'string') {
    throw new Error('requestedModel is required.');
  }
  return {
    model: gateway(slug),
    providerLabel: inferModelFamily(slug),
    modelId: slug,
  };
}
