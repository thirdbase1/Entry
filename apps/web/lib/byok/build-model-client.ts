/**
 * Builds a real `LanguageModel` client straight from a provider row's own
 * connection details (baseURL + decrypted key + compatibility mode) and a
 * model slug — the exact same construction resolve-model.ts's
 * `resolveByokModel` uses for actual chat turns, extracted out so the
 * "Test connection" route (settings page, 2026-07-15) can build one too
 * without resolveByokModel's `isEnabled: true` + row-lookup requirements.
 * A model should be testable *before* it's toggled on / while just picked
 * from a dropdown, not only once already enabled for chat.
 */
import type { LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { ByokCompatibility } from '@entry/db';
import { createGatewayRetryFetch } from './gateway-retry-fetch';

export interface ByokProviderConnection {
  label: string;
  compatibility: ByokCompatibility;
  baseUrl: string;
  apiKey: string | undefined;
}

/** Optional -- only used to tag durable retry/exhaustion logs (see
 *  gateway-retry-fetch.ts) with who/what was actually affected. Omitting
 *  it (e.g. from a context where userId isn't cheaply available) just
 *  means those specific log rows have a blank userId -- never blocks
 *  building the client. */
export interface BuildModelClientContext {
  userId?: string;
}

export function buildModelClient(provider: ByokProviderConnection, modelId: string, ctx?: BuildModelClientContext): LanguageModel {
  switch (provider.compatibility) {
    case 'ANTHROPIC':
      return createAnthropic({ baseURL: provider.baseUrl, apiKey: provider.apiKey })(modelId);
    case 'GOOGLE':
      return createGoogleGenerativeAI({ baseURL: provider.baseUrl, apiKey: provider.apiKey })(modelId);
    case 'OPENAI_RESPONSES':
      // See resolve-model.ts's identical case for why `apiKey ?? ''` (never
      // `undefined`) matters — same @ai-sdk/openai env-fallback footgun
      // applies here too.
      return createOpenAI({ baseURL: provider.baseUrl, apiKey: provider.apiKey ?? '' }).responses(modelId);
    case 'OPENAI':
    default:
      return createOpenAICompatible({
        name: provider.label,
        baseURL: provider.baseUrl,
        apiKey: provider.apiKey,
        fetch: createGatewayRetryFetch({ providerLabel: provider.label, userId: ctx?.userId }),
      })(modelId);
  }
}
