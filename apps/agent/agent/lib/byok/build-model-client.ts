/**
 * Builds a real `LanguageModel` client straight from a provider row's own
 * connection details (baseURL + decrypted key + compatibility mode) and a
 * model slug — the exact same construction resolve-model.ts's
 * `resolveByokModel` uses for actual chat turns, extracted out so the
 * "Test connection" route (settings page, 2026-07-15) can build one too
 * without resolveByokModel's `isEnabled: true` + row-lookup requirements.
 * A model should be testable *before* it's toggled on / while just picked
 * from a dropdown, not only once already enabled for chat.
 *
 * MEMORY OPTIMIZATION (2026-07-21, Render 512MB-tier OOM investigation):
 * all four @ai-sdk/* provider packages used to be static top-level imports,
 * meaning every one of them got loaded into the worker's resident memory on
 * boot regardless of which provider(s) a given deployment/user actually
 * uses. Switched to dynamic `import()` inside each branch so only the
 * provider actually hit on a given call gets pulled into memory. Node/ESM
 * caches the dynamic import after first use, so this costs nothing on
 * repeat calls -- it only avoids the *unconditional* upfront load.
 */
import type { LanguageModel } from 'ai';
import type { ByokCompatibility } from '@entry/db';
import { createGatewayRetryFetch } from './gateway-retry-fetch';

export interface ByokProviderConnection {
  label: string;
  compatibility: ByokCompatibility;
  baseUrl: string;
  apiKey: string | undefined;
}

export async function buildModelClient(provider: ByokProviderConnection, modelId: string): Promise<LanguageModel> {
  // FIXED (2026-07-23, user-reported slow/flaky BYOK connections): every
  // branch below now gets the SAME fetch -- previously only the
  // OPENAI/default branch had `createGatewayRetryFetch()`, meaning
  // ANTHROPIC / GOOGLE / OPENAI_RESPONSES BYOK providers got zero retry
  // resilience against the relay's known transient-error family (see
  // gateway-retry-fetch.ts) AND paid for a fresh TCP+TLS handshake on
  // basically every request (Node's default 4s undici keep-alive timeout
  // routinely expires between a tool call and the model's next request --
  // see keep-alive-dispatcher.ts). One shared fetch wrapper now gives
  // every compatibility mode both the long-lived connection pool and the
  // transient-retry logic identically.
  const byokFetch = createGatewayRetryFetch();

  switch (provider.compatibility) {
    case 'ANTHROPIC': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ baseURL: provider.baseUrl, apiKey: provider.apiKey, fetch: byokFetch })(modelId);
    }
    case 'GOOGLE': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ baseURL: provider.baseUrl, apiKey: provider.apiKey, fetch: byokFetch })(modelId);
    }
    case 'OPENAI_RESPONSES': {
      // See resolve-model.ts's identical case for why `apiKey ?? ''` (never
      // `undefined`) matters — same @ai-sdk/openai env-fallback footgun
      // applies here too.
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ baseURL: provider.baseUrl, apiKey: provider.apiKey ?? '', fetch: byokFetch }).responses(modelId);
    }
    case 'OPENAI':
    default: {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      return createOpenAICompatible({
        name: provider.label,
        baseURL: provider.baseUrl,
        apiKey: provider.apiKey,
        fetch: byokFetch,
      })(modelId);
    }
  }
}
