import { NextRequest, NextResponse } from 'next/server';
import { gateway } from '@ai-sdk/gateway';
import { inferModelFamily } from '@/lib/model-provider';

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
 * public catalog endpoint (`getAvailableModels()` itself doesn't expose
 * per-model tags) — the model picker uses it to only show a reasoning-
 * effort selector for models that actually support one, instead of
 * showing a control that silently no-ops (or worse, confusing a user
 * into thinking a plain non-reasoning model is "thinking" when it isn't).
 */

let reasoningTagCache: { slugs: Set<string>; fetchedAt: number } | null = null;
const REASONING_TAG_TTL_MS = 5 * 60 * 1000;

async function getReasoningCapableSlugs(): Promise<Set<string>> {
  if (reasoningTagCache && Date.now() - reasoningTagCache.fetchedAt < REASONING_TAG_TTL_MS) {
    return reasoningTagCache.slugs;
  }
  try {
    const res = await fetch('https://ai-gateway.vercel.sh/v1/models/catalog');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models: { slug: string; providers: { tags?: string[] }[] }[] };
    const slugs = new Set(
      data.models.filter(m => m.providers.some(p => p.tags?.includes('reasoning'))).map(m => m.slug)
    );
    reasoningTagCache = { slugs, fetchedAt: Date.now() };
    return slugs;
  } catch {
    // Best-effort — if the catalog tag lookup fails, fall back to no model
    // showing the reasoning-effort control rather than breaking the whole
    // model list request over a secondary metadata fetch.
    return reasoningTagCache?.slugs ?? new Set();
  }
}

export async function GET(_req: NextRequest) {
  try {
    const [{ models }, reasoningSlugs] = await Promise.all([
      gateway.getAvailableModels(),
      getReasoningCapableSlugs(),
    ]);

    // Filter to language models only (the kind users can chat with)
    const languageModels = models
      .filter(m => m.modelType === 'language' || !m.modelType)
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
