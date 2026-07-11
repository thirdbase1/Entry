/**
 * Thin helper so tools that need their OWN model call (structured
 * generation, summarization, code drafting — not the main agent turn,
 * which eve already drives via agent.ts's `model:`) go through the same
 * Vercel AI Gateway the rest of the stack standardized on, without pulling
 * in packages/ai's zod-v3-typed `copilotProvider` (this app pins zod v4,
 * per eve's own `defineTool` Standard Schema requirement).
 *
 * FIXED (2026-07-11) — real, confirmed cause of "tool calling is slow":
 * the previous policy here ("first live capable match" from
 * `gateway.getAvailableModels()`, mirroring packages/ai/src/provider.ts)
 * resolved, in production right now, to `bytedance/seed-1.8` — a
 * reasoning-capable model — for EVERY SINGLE call these 5 tools make
 * (task_analysis, code_artifact, python_coding, make_it_real, doc_compose).
 * That's not a deliberate choice anywhere in the code, just whatever
 * happens to sort first in the Gateway's catalog response — entirely
 * unrelated to speed, and actively the opposite of it. Every one of these
 * tool calls was paying for a full reasoning-model completion as a hidden
 * side effect nested inside a single step of the OUTER agent loop, on top
 * of that outer loop's own per-step latency — directly compounding the
 * "any time it does tool calling" complaint.
 *
 * Now defaults to an explicit, fast, non-reasoning alias suited to these
 * tasks (structured JSON / short code drafts / markdown bodies — none of
 * which need frontier reasoning). Per standing instruction, this is a
 * Gateway alias (`provider/model-name`), never a dated vendor-specific
 * snapshot id. Falls back to the old "first live match" catalog lookup
 * only if the pinned model is ever missing from the live catalog, so this
 * never hard-fails just because a provider renames/retires one id.
 */
import { gateway } from '@ai-sdk/gateway';
import type { LanguageModel } from 'ai';

const FAST_DEFAULT_MODEL_ID = 'anthropic/claude-3.5-haiku';

let cachedDefault: { id: string; fetchedAt: number } | null = null;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

async function resolveDefaultModelId(): Promise<string> {
  if (cachedDefault && Date.now() - cachedDefault.fetchedAt < DEFAULT_TTL_MS) {
    return cachedDefault.id;
  }
  const { models } = await gateway.getAvailableModels();
  const pinned = models.find(m => m.id === FAST_DEFAULT_MODEL_ID);
  if (pinned) {
    cachedDefault = { id: pinned.id, fetchedAt: Date.now() };
    return pinned.id;
  }
  // Pinned fast model isn't live right now (renamed/retired upstream) —
  // fall back to a couple of other known-fast, non-reasoning aliases
  // before falling back to just the first language model at all, so an
  // outage in the pinned id doesn't silently reintroduce the
  // reasoning-model tax either. (GatewayLanguageModelEntry has no
  // `reasoning` flag to filter by generically -- /api/server/models
  // derives that client-facing flag from its own separate metadata, not
  // from this raw catalog type -- so fall back to a short explicit list
  // instead of an inferred filter.)
  const otherFastAliases = ['openai/gpt-4o-mini', 'google/gemini-2.5-flash-lite'];
  const candidate =
    otherFastAliases.map(id => models.find(m => m.id === id)).find(Boolean) ??
    models.find(m => m.modelType === 'language' || !m.modelType);
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
