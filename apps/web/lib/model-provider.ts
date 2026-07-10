/**
 * Infers a "brand family" purely from a model's id/name string — used to
 * pick the right logo regardless of which provider connection or gateway
 * slug is behind it. A BYOK model set to "OpenAI-compatible" transport
 * (e.g. a Llama model served by Groq, or a Mistral model served by
 * Together) still gets its OWN brand icon, not the transport's.
 *
 * Shared by both the AI Gateway model list (/api/server/models) and the
 * BYOK model list (chat-config.tsx) so identical model names always
 * resolve to the identical icon everywhere in the UI.
 *
 * Family list matches the full set of language-model providers actually
 * seen in the AI Gateway catalog (apps/agent/.eve/cache/model-catalog.json
 * providers: alibaba, amazon, anthropic, arcee-ai, bytedance, cohere,
 * deepseek, google, inception, meta, minimax, mistral, moonshotai, morph,
 * nvidia, openai, perplexity, xai, zai — plus a few niche ones with no
 * distinct brand icon available, left as 'unknown').
 */
export type ModelFamily =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'meta'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'cohere'
  | 'qwen'
  | 'perplexity'
  | 'amazon'
  | 'bytedance'
  | 'minimax'
  | 'moonshot'
  | 'nvidia'
  | 'stepfun'
  | 'zhipu'
  | 'arcee'
  | 'inception'
  | 'morph'
  | 'unknown';

export function inferModelFamily(modelIdOrName: string): ModelFamily {
  const id = modelIdOrName.toLowerCase();

  if (id.includes('claude') || id.includes('anthropic')) return 'anthropic';
  if (id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('o4') || id.includes('openai') || id.includes('chatgpt')) return 'openai';
  if (id.includes('gemini') || id.includes('palm') || (id.includes('google') && !id.includes('googleapis'))) return 'google';
  if (id.includes('llama') || id.startsWith('meta') || id.includes('meta-') || id.includes('/meta')) return 'meta';
  if (id.includes('mistral') || id.includes('mixtral') || id.includes('codestral') || id.includes('pixtral')) return 'mistral';
  if (id.includes('deepseek')) return 'deepseek';
  if (id.includes('grok') || id.includes('xai')) return 'xai';
  if (id.includes('command') || id.includes('cohere')) return 'cohere';
  if (id.includes('qwen') || id.includes('tongyi') || id.startsWith('alibaba') || id.includes('/alibaba')) return 'qwen';
  if (id.includes('sonar') || id.includes('perplexity')) return 'perplexity';
  if (id.includes('nova') || id.startsWith('amazon') || id.includes('/amazon') || id.includes('titan')) return 'amazon';
  if (id.includes('doubao') || id.startsWith('bytedance') || id.includes('/bytedance') || id.includes('seed-')) return 'bytedance';
  if (id.includes('minimax') || id.includes('abab') || id.includes('hailuo')) return 'minimax';
  if (id.includes('moonshot') || id.includes('kimi')) return 'moonshot';
  if (id.includes('nvidia') || id.includes('nemotron')) return 'nvidia';
  if (id.includes('stepfun') || id.includes('step-')) return 'stepfun';
  if (id.includes('zai') || id.includes('glm') || id.includes('zhipu')) return 'zhipu';
  if (id.includes('arcee')) return 'arcee';
  if (id.includes('inception') || id.includes('mercury')) return 'inception';
  if (id.includes('morph')) return 'morph';

  return 'unknown';
}
