import { NextRequest, NextResponse } from 'next/server';
import { gateway } from '@ai-sdk/gateway';
import { inferModelFamily } from '@/lib/model-provider';
import { getReasoningCapableGatewaySlugs } from '@/lib/direct-chat/reasoning-capability';

/**
 * GET /api/server/models
 * Fetch available models from the Vercel AI Gateway catalog.
 * Returns language-type models with their metadata.
 *
 * This replaces the hardcoded `tempModels` array in the original's
 * chat-config.tsx. The original fetched from its own provider resolver;
 * we fetch directly from the AI Gateway catalog.
 *
 * `reasoning: boolean` per model is cross-referenced from the Gateway's
 * public catalog endpoint (`getReasoningCapableGatewaySlugs`, shared with
 * /api/direct/chat's own server-side enforcement so the picker's "does
 * this model show a reasoning control" and the backend's "does this model
 * actually get sent a reasoning param" can never disagree) — the model
 * picker uses it to only show a reasoning-effort selector for models that
 * actually support one, instead of showing a control that silently no-ops
 * (or worse, confusing a user into thinking a plain non-reasoning model is
 * "thinking" when it isn't).
 */
/**
 * Model ids (or id substrings) known to be fundamentally incompatible
 * with this app's chat, and therefore hidden from the picker entirely --
 * not a quality/preference exclusion, a hard-compatibility one.
 *
 * `antigravity` (2026-07-24, real confirmed incident: a user's turn
 * "stopped while working" ~40s in, mid-conversation, no client-side bug
 * involved at all): Google's API hard-rejects ANY multi-turn request to
 * `antigravity-preview-*` models with a 400 --
 * `Multiturn chat is not enabled for models/antigravity-preview-05-2026`
 * (confirmed via the raw Gateway error body in server logs). This is a
 * genuine, permanent Google-side restriction on this preview model family,
 * not a transient/rate-limit error -- every chat here inherently involves
 * multiple turns (each tool call round-trip is its own turn), so this
 * model family can never complete more than one exchange in this app,
 * no matter what. Excluding it from the catalog entirely is the only
 * real fix -- there's no retry or client-side handling that helps once
 * the model itself refuses the request shape the conversation requires.
 */
const INCOMPATIBLE_MODEL_ID_SUBSTRINGS = ['antigravity'];

function isCompatibleModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !INCOMPATIBLE_MODEL_ID_SUBSTRINGS.some(bad => lower.includes(bad));
}

export async function GET(_req: NextRequest) {
  try {
    const [{ models }, reasoningSlugs] = await Promise.all([
      gateway.getAvailableModels(),
      getReasoningCapableGatewaySlugs(),
    ]);

    // Filter to language models only (the kind users can chat with), and
    // drop known-incompatible model families (see
    // INCOMPATIBLE_MODEL_ID_SUBSTRINGS's own comment above).
    const languageModels = models
      .filter(m => (m.modelType === 'language' || !m.modelType) && isCompatibleModel(m.id))
      .map(m => ({
        id: m.id,
        name: m.name || m.id,
        provider: inferModelFamily(m.id),
        description: m.description || null,
        reasoning: reasoningSlugs.has(m.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ models: languageModels });
  } catch (error) {
    // If the Gateway is unreachable (no API key, network), fall back to
    // a curated list matching the original's tempModels so the UI still works.
    // Gateway alias slugs (provider-prefixed, not dated vendor ids) —
    // matches the standing "AI Gateway aliases only" rule. Only used if the
    // live catalog call above fails (no network / no Gateway key).
    const fallback = [
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', provider: 'anthropic', description: null, reasoning: true },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', description: null, reasoning: true },
      { id: 'openai/gpt-5.1', name: 'GPT-5.1', provider: 'openai', description: null, reasoning: true },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', description: null, reasoning: true },
      { id: 'openai/gpt-5.1-mini', name: 'GPT-5.1 Mini', provider: 'openai', description: null, reasoning: true },
    ];
    return NextResponse.json({ models: fallback });
  }
}
