/**
 * Thin helper so tools that need their OWN model call (structured
 * generation, summarization, code drafting — not the main agent turn,
 * which eve already drives via agent.ts's `model:`) go through the same
 * Vercel AI Gateway the rest of the stack standardized on, without pulling
 * in packages/ai's zod-v3-typed `copilotProvider` (this app pins zod v4,
 * per eve's own `defineTool` Standard Schema requirement).
 *
 * Per explicit instruction, NO hardcoded model id lives here anymore.
 * `resolveModel()` fetches the live Gateway catalog
 * (`gateway.getAvailableModels()`, same API packages/ai/src/models.ts
 * uses) and picks the first language-type model — same "no
 * defaultForOutputType flag, first live capable match" policy as
 * packages/ai/src/provider.ts, so both apps resolve defaults the same way.
 * Callers that need a SPECIFIC model still just pass its id straight
 * through — this only removes the *fallback* hardcoding, not the ability
 * to target an exact model.
 */
import { gateway } from '@ai-sdk/gateway';

let cachedDefault: { id: string; fetchedAt: number } | null = null;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

async function resolveDefaultModelId(): Promise<string> {
  if (cachedDefault && Date.now() - cachedDefault.fetchedAt < DEFAULT_TTL_MS) {
    return cachedDefault.id;
  }
  const { models } = await gateway.getAvailableModels();
  const candidate = models.find(m => m.modelType === 'language' || !m.modelType);
  if (!candidate) {
    throw new Error('No language model returned by the Gateway catalog — check AI_GATEWAY_API_KEY / connectivity.');
  }
  cachedDefault = { id: candidate.id, fetchedAt: Date.now() };
  return candidate.id;
}

/** Pass an explicit modelId to target a specific model; omit to resolve the live default. */
export async function model(modelId?: string) {
  const id = modelId ?? (await resolveDefaultModelId());
  return gateway(id);
}
