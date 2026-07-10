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
import type { LanguageModel } from 'ai';

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

/**
 * Pass an explicit modelId to target a specific Gateway model; omit to
 * resolve the live default. Pass `override` when the caller already has a
 * concrete, non-Gateway `LanguageModel` it must use instead (a BYOK model)
 * — this is the ONLY thing that makes these sub-generation calls
 * (task_analysis, code_artifact, python_coding, make_it_real, doc_compose)
 * honor BYOK. Without it, these tools always silently called Gateway for
 * their own internal generation step even when the top-level turn was a
 * BYOK model, since each tool's `model()` call had no way to know a BYOK
 * model was in play — confirmed by reading run_model.ts's ctx wiring:
 * these 5 tools never received `ctx` at all (only 3 of 9 tools did), and
 * even the 3 that did (browser_use, make_it_real, doc_compose) never
 * threaded ctx's model choice into their own `model()` calls.
 */
export async function model(modelId?: string, override?: LanguageModel): Promise<LanguageModel> {
  if (override) return override;
  const id = modelId ?? (await resolveDefaultModelId());
  return gateway(id);
}
