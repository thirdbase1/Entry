/**
 * Anthropic prompt-cache breakpoints for the direct-model chat path.
 *
 * Why this exists (2026-07-14, real fix for "Sonnet is supposed to be fast
 * but this is so slow" reports): confirmed by grep that this route had
 * ZERO cache_control breakpoints anywhere before this change, so the fixed
 * ~7KB persona system prompt plus the full JSON schema for up to 18 tools
 * got reprocessed from scratch by the model on every single turn instead
 * of reusing the previous turn's cached prefix -- the documented common
 * cause of "Claude feels slow" when a large fixed prefix repeats turn over
 * turn (Anthropic's own docs cite up to ~85% latency reduction on the
 * cached portion). eve's root agent already solves this internally (see
 * node_modules/eve/dist/src/harness/prompt-cache.js -- not a public export,
 * so re-implemented here rather than reaching into eve's internals) with a
 * 3-breakpoint strategy: last tool definition, the system message, and the
 * last user+assistant turn. This ports that exact strategy for this bare
 * `streamText` call so it gets the same real, working behavior.
 *
 * `providerOptions.anthropic.cacheControl` is provider-namespaced -- safe
 * to always attach regardless of which model actually got resolved for a
 * turn (Gateway OpenAI/Google/DeepSeek/xAI picks and non-Anthropic BYOK
 * keys just ignore an `anthropic` key they don't recognize).
 */
import type { ModelMessage, Tool, ToolSet } from 'ai';

const CACHE_MARKER = { anthropic: { cacheControl: { type: 'ephemeral' as const, ttl: '5m' as const } } };

/** Cache breakpoint on the LAST tool definition -- caches the entire tools block (all schemas before it) as one unit. */
export function applyToolCacheBreakpoint<T extends ToolSet>(tools: T): T {
  const entries = Object.entries(tools);
  if (entries.length === 0) return tools;
  const result: Record<string, Tool> = {};
  entries.forEach(([name, def], i) => {
    if (i === entries.length - 1) {
      result[name] = { ...def, providerOptions: { ...(def as Tool).providerOptions, ...CACHE_MARKER } };
    } else {
      result[name] = def as Tool;
    }
  });
  return result as T;
}

/** A system message carrying a cache breakpoint -- use in place of streamText's plain `system` string param, which has no providerOptions slot to attach caching to. */
export function buildCachedSystemMessage(systemPrompt: string): ModelMessage {
  return { role: 'system', content: systemPrompt, providerOptions: CACHE_MARKER } as ModelMessage;
}

/** Cache breakpoints on the last assistant AND last user message -- lets the growing conversation history itself get cached incrementally turn over turn, which matters most for exactly the long-running, many-tool-call sessions this was hardest to keep fast on. */
export function applyConversationCacheControl(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const result = [...messages];
  let cachedAssistant = false;
  let cachedUser = false;
  for (let i = result.length - 1; i >= 0 && (!cachedAssistant || !cachedUser); i--) {
    const m = result[i];
    if (!cachedAssistant && m.role === 'assistant') {
      result[i] = { ...m, providerOptions: { ...m.providerOptions, ...CACHE_MARKER } };
      cachedAssistant = true;
    } else if (!cachedUser && m.role === 'user') {
      result[i] = { ...m, providerOptions: { ...m.providerOptions, ...CACHE_MARKER } };
      cachedUser = true;
    }
  }
  return result;
}
