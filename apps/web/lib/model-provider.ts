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
  | 'unknown';

export function inferModelFamily(modelIdOrName: string): ModelFamily {
  const id = modelIdOrName.toLowerCase();

  if (id.includes('claude') || id.includes('anthropic')) return 'anthropic';
  if (id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('o4') || id.includes('openai') || id.includes('chatgpt')) return 'openai';
  if (id.includes('gemini') || id.includes('palm') || (id.includes('google') && !id.includes('googleapis'))) return 'google';
  if (id.includes('llama') || id.includes('meta-')) return 'meta';
  if (id.includes('mistral') || id.includes('mixtral') || id.includes('codestral')) return 'mistral';
  if (id.includes('deepseek')) return 'deepseek';
  if (id.includes('grok') || id.includes('xai')) return 'xai';
  if (id.includes('command') || id.includes('cohere')) return 'cohere';
  if (id.includes('qwen') || id.includes('tongyi')) return 'qwen';
  if (id.includes('sonar') || id.includes('perplexity')) return 'perplexity';

  return 'unknown';
}
