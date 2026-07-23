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
import { createGateway } from '@ai-sdk/gateway';
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
  // FIXED (2026-07-23, user-reported slow/flaky BYOK connections): every
  // branch below now shares ONE fetch -- previously only the OPENAI/default
  // branch got `createGatewayRetryFetch()`, so ANTHROPIC / GOOGLE /
  // OPENAI_RESPONSES BYOK providers got zero retry resilience against this
  // relay family's known transient-error shapes (see gateway-retry-fetch.ts)
  // AND paid for a brand new TCP+TLS handshake on nearly every request --
  // Node's default 4s undici keep-alive timeout routinely expires during a
  // tool call, so the next request to the same BYOK origin never reuses a
  // warm socket (see keep-alive-dispatcher.ts). This one shared fetch now
  // gives every compatibility mode both the long-lived connection pool and
  // the transient-retry logic identically.
  const byokFetch = createGatewayRetryFetch({ providerLabel: provider.label, userId: ctx?.userId });

  switch (provider.compatibility) {
    case 'ANTHROPIC':
      return createAnthropic({ baseURL: provider.baseUrl, apiKey: provider.apiKey, fetch: byokFetch })(modelId);
    case 'GOOGLE':
      return createGoogleGenerativeAI({ baseURL: provider.baseUrl, apiKey: provider.apiKey, fetch: byokFetch })(modelId);
    case 'OPENAI_RESPONSES':
      // See resolve-model.ts's identical case for why `apiKey ?? ''` (never
      // `undefined`) matters — same @ai-sdk/openai env-fallback footgun
      // applies here too.
      return createOpenAI({ baseURL: provider.baseUrl, apiKey: provider.apiKey ?? '', fetch: byokFetch }).responses(modelId);
    // ADDED (2026-07-23, "add AI gateway in the byok place ... make it
    // more advanced so user just needs to add API key only"): a BYOK
    // connection in this mode is NOT a plain baseUrl+key REST call like
    // every other case here -- it's the user's own Vercel AI Gateway
    // account, built with the AI SDK's own dedicated Gateway client
    // (createGateway), which handles Gateway's actual protocol (its own
    // auth headers/protocol version, model-id routing like
    // "inclusionai/ling-3.0-flash-free") correctly instead of us trying
    // to hand-roll it as a fake OpenAI-compatible endpoint. `baseUrl` is
    // deliberately NOT passed here -- createGateway() already defaults to
    // Vercel's real Gateway endpoint on its own, and this provider row's
    // stored baseUrl is only ever a fixed display value (see
    // normalizeBaseUrl / the settings-page UI, which hides that field
    // entirely for this mode). Passing our shared byokFetch still gives
    // this the same keep-alive pooling + transient-retry resilience every
    // other BYOK mode gets.
    case 'AI_GATEWAY':
      // GUARD (2026-07-23, real footgun caught during implementation):
      // @ai-sdk/gateway's own auth resolution
      // (getGatewayAuthToken/loadOptionalSetting) silently falls back to
      // process.env.AI_GATEWAY_API_KEY -- THIS APP'S OWN SHARED GATEWAY
      // CREDENTIAL, already used elsewhere for the non-BYOK model catalog
      // -- whenever no apiKey is passed. A BYOK row that somehow ends up
      // keyless in this mode (should be prevented at create/update time,
      // see providers/route.ts's refine, but this is the one place that
      // actually MATTERS -- every other safeguard is just UX) would
      // otherwise silently bill and rate-limit against our own shared
      // key instead of erroring, completely defeating the point of BYOK.
      // Hard-fail instead of ever letting that fallback engage.
      if (!provider.apiKey) {
        throw new Error(`AI Gateway connection "${provider.label}" has no API key saved -- add your own Vercel AI Gateway key in Settings before using it.`);
      }
      return createGateway({ apiKey: provider.apiKey, fetch: byokFetch })(modelId);
    case 'OPENAI':
    default:
      return createOpenAICompatible({
        name: provider.label,
        baseURL: provider.baseUrl,
        apiKey: provider.apiKey,
        fetch: byokFetch,
      })(modelId);
  }
}
