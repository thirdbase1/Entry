import { NextRequest, NextResponse } from 'next/server';
import { gateway } from '@ai-sdk/gateway';

/**
 * GET /api/server/models
 * Fetch available models from the Vercel AI Gateway catalog.
 * Returns language-type models with their metadata.
 *
 * This replaces the hardcoded `tempModels` array in the original's
 * chat-config.tsx. The original fetched from its own provider resolver;
 * we fetch directly from the AI Gateway catalog.
 */
export async function GET(_req: NextRequest) {
  try {
    const { models } = await gateway.getAvailableModels();

    // Filter to language models only (the kind users can chat with)
    const languageModels = models
      .filter(m => m.modelType === 'language' || !m.modelType)
      .map(m => ({
        id: m.id,
        name: m.name || m.id,
        provider: inferProvider(m.id),
        
        description: m.description || null,
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
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', provider: 'anthropic', description: null },
      { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', description: null },
      { id: 'openai/gpt-5.1', name: 'GPT-5.1', provider: 'openai', description: null },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', description: null },
      { id: 'openai/gpt-5.1-mini', name: 'GPT-5.1 Mini', provider: 'openai', description: null },
    ];
    return NextResponse.json({ models: fallback });
  }
}

function inferProvider(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.includes('claude') || id.includes('anthropic')) return 'anthropic';
  if (id.includes('gpt') || id.includes('o3') || id.includes('o4') || id.includes('openai')) return 'openai';
  if (id.includes('gemini') || id.includes('google')) return 'google';
  if (id.includes('llama') || id.includes('meta')) return 'meta';
  if (id.includes('mistral') || id.includes('mixtral')) return 'mistral';
  if (id.includes('deepseek')) return 'deepseek';
  return 'unknown';
}
