/**
 * Single AI provider for the whole app: Vercel AI Gateway, via AI SDK 7.
 *
 * Replaces the original per-vendor setup in
 * packages/backend/server/src/plugins/copilot/providers/*
 * (separate @ai-sdk/anthropic, @ai-sdk/google, @ai-sdk/google-vertex,
 * @ai-sdk/openai, @ai-sdk/openai-compatible, @ai-sdk/perplexity packages).
 *
 * With the Gateway, every model is addressed as "provider/model" through
 * ONE credential (AI_GATEWAY_API_KEY), and Vercel handles routing, fallback,
 * budgets and observability. No behavior change is needed at call sites that
 * already use `generateText` / `streamText` / `tool()` from `ai`.
 */
import { createGateway } from '@ai-sdk/gateway';

export const gateway = createGateway({
  // On Vercel, VERCEL_OIDC_TOKEN is automatically available — no API key needed.
  // AI_GATEWAY_API_KEY is only needed for local dev. If both are set, the key takes priority.
  apiKey: process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN,
});

// Model IDs map 1:1 to what the original CopilotProviderType enum exposed,
// just addressed through the gateway instead of a vendor-specific client.
export const models = {
  // was CopilotProviderType.Anthropic
  claude: (id: string) => gateway(`anthropic/${id}`),
  // was CopilotProviderType.OpenAI
  gpt: (id: string) => gateway(`openai/${id}`),
  // was CopilotProviderType.Google / GoogleVertex
  gemini: (id: string) => gateway(`google/${id}`),
  // was CopilotProviderType.Perplexity
  perplexity: (id: string) => gateway(`perplexity/${id}`),
  // any OpenAI-compatible self-hosted/custom endpoint the original
  // @ai-sdk/openai-compatible package covered — Gateway supports custom
  // providers registered in the Vercel dashboard under the same interface.
  custom: (id: string) => gateway(id),
} as const;
