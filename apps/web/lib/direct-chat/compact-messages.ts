/**
 * Context compaction for the direct-model chat path (/api/direct/chat).
 *
 * Why this exists (2026-07-14, real gap found auditing "the AI forgets on
 * long projects" reports from beta testers): eve's root agent
 * (apps/agent/agent/agent.ts) ships with `compaction: { thresholdPercent:
 * 0.9 }` -- eve's own runtime automatically summarizes earlier turns once
 * the context window fills past 90%, so that path never silently loses
 * history. The direct-chat route is a deliberately separate, bare
 * `streamText` call outside eve's runtime entirely (see that route's file
 * comment) -- it never went through the same hardening, so it has ALWAYS
 * sent the client's full raw message history to the model, every single
 * turn, with zero token-budget awareness at all. Confirmed real
 * consequence for any long agentic session (many tool calls, each with a
 * sizeable output -- full bash stdout, browser
 * screenshots) on this path: total tokens eventually exceed the resolved
 * model's context window, and depending on the provider that means either
 * a hard "context length exceeded" error (matches "runs into issues"
 * reports) or the provider's own silent truncation from the start of the
 * conversation (matches "forgets" reports) -- this route had no defense
 * against either outcome.
 *
 * Fix: before every model call, estimate the token size of the message
 * history; if it's past a safe budget for the resolved model's real
 * context window (from the same public AI Gateway catalog eve's own
 * compiler and model-catalog.ts already use), summarize everything except
 * a recent tail into ONE synthetic message via a cheap direct call to the
 * SAME model already resolved for this turn (no second provider config to
 * maintain), and send [summary, ...recentTail] to the model instead of the
 * full raw history.
 *
 * Deliberately does NOT touch what's persisted to the DB or shown in the
 * UI -- `uiMessages` (the full, real history) stays exactly as the user
 * sees it; only the array actually handed to `convertToModelMessages` for
 * THIS model call is ever shortened. Nothing the user typed or the
 * assistant said is ever deleted from the visible chat, only compacted
 * out of what gets re-sent to the model on very long sessions -- this is
 * the same non-destructive intent as eve's own compaction, just
 * implemented at this route's level instead of inside eve's runtime.
 */
import { generateText, type UIMessage } from 'ai';
import type { LanguageModel } from 'ai';

interface CatalogProvider {
  provider: string;
  providerModelId: string;
  contextWindowTokens?: number;
}
interface CatalogModel {
  slug: string;
  providers: CatalogProvider[];
}
interface CatalogResponse {
  models: CatalogModel[];
}

let catalogCache: { data: CatalogResponse; fetchedAt: number } | null = null;
const CATALOG_TTL_MS = 5 * 60 * 1000;

async function fetchCatalog(): Promise<CatalogResponse> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.data;
  }
  const res = await fetch('https://ai-gateway.vercel.sh/v1/models/catalog');
  if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
  const data = (await res.json()) as CatalogResponse;
  catalogCache = { data, fetchedAt: Date.now() };
  return data;
}

// Conservative fallback when the model isn't found in the public Gateway
// catalog at all (most BYOK picks -- a user's own direct provider key,
// never routed through the Gateway, so it's never IN that catalog) or the
// catalog fetch itself fails (network blip). 128k is a safe floor most
// current-generation models meet or beat; erring low just means we
// compact a bit earlier than strictly necessary, never later than safe.
const FALLBACK_CONTEXT_WINDOW = 128_000;

async function getContextWindowTokens(modelId: string): Promise<number> {
  try {
    const { models } = await fetchCatalog();
    const match = models.find(m => m.slug === modelId);
    if (!match) return FALLBACK_CONTEXT_WINDOW;
    const best = Math.max(0, ...match.providers.map(p => p.contextWindowTokens ?? 0));
    return best > 0 ? best : FALLBACK_CONTEXT_WINDOW;
  } catch {
    return FALLBACK_CONTEXT_WINDOW;
  }
}

// Rough, dependency-free token estimate (~4 chars/token -- the standard
// quick heuristic; no tokenizer package in this repo and adding one just
// for an estimate used purely to decide WHEN to compact isn't worth a new
// dependency). Being approximate is fine here: the threshold below already
// leaves a wide safety margin, so small estimate error never matters.
function estimateTokens(uiMessages: UIMessage[]): number {
  const json = JSON.stringify(uiMessages);
  return Math.ceil(json.length / 4);
}

// How much of the context window we allow real history to occupy before
// compacting -- leaves headroom for the system prompt, tool schemas, and
// the model's own output. Matches the spirit of eve's 0.9 threshold, kept
// a bit lower here (0.7) because this path also carries a large tool set
// (18 tool schemas, see route.ts) whose combined schema text isn't counted
// by estimateTokens above (it only sees `uiMessages`), so the real margin
// needs to be bigger to stay safely under the model's actual limit.
const COMPACTION_THRESHOLD = 0.7;

// Always keep the most recent N messages verbatim, uncompacted -- recent
// turns are exactly the ones the model most needs full fidelity on
// (what the user just asked, what it just did).
const KEEP_RECENT_MESSAGES = 16;

function flattenMessageText(m: UIMessage): string {
  if (!Array.isArray((m as any).parts)) return '';
  return (m as any).parts
    .map((p: any) => {
      if (p.type === 'text') return p.text ?? '';
      if (p.type?.startsWith('tool-')) return `[tool call: ${p.type} -> ${JSON.stringify(p.output ?? p.input ?? '').slice(0, 500)}]`;
      return '';
    })
    .join(' ');
}

export interface CompactionResult {
  messages: UIMessage[];
  wasCompacted: boolean;
  /** Set only when `wasCompacted` is true. The caller (route.ts) folds
   *  this into `streamText`'s `instructions` param alongside the main
   *  persona system prompt -- see below for why this is no longer a fake
   *  `role: 'system'` entry spliced into the returned `messages` array. */
  summaryText?: string;
}

/**
 * Returns a possibly-shortened copy of `uiMessages` safe to hand to
 * `convertToModelMessages` for THIS turn's model call. Never mutates or
 * returns a shortened view of what should be persisted/shown -- callers
 * must keep using the original `uiMessages` for the DB/UI.
 */
export async function compactMessagesIfNeeded(uiMessages: UIMessage[], model: LanguageModel, modelId: string): Promise<CompactionResult> {
  if (uiMessages.length <= KEEP_RECENT_MESSAGES) {
    return { messages: uiMessages, wasCompacted: false };
  }

  const [estimatedTokens, contextWindow] = await Promise.all([Promise.resolve(estimateTokens(uiMessages)), getContextWindowTokens(modelId)]);

  if (estimatedTokens < contextWindow * COMPACTION_THRESHOLD) {
    return { messages: uiMessages, wasCompacted: false };
  }

  const olderMessages = uiMessages.slice(0, -KEEP_RECENT_MESSAGES);
  const recentMessages = uiMessages.slice(-KEEP_RECENT_MESSAGES);

  const transcript = olderMessages
    .map(m => `${m.role}: ${flattenMessageText(m)}`)
    .filter(line => line.trim().length > 0)
    .join('\n');

  let summaryText: string;
  try {
    const { text } = await generateText({
      model,
      system:
        'You compress an earlier part of a long agent conversation into a dense, factual briefing note for ' +
        'your own future self. Preserve: the original goal/task, concrete decisions made, file paths/names ' +
        'touched, credentials or config values referenced (by name, not by value), URLs, IDs, and any open ' +
        'problems or TODOs still outstanding. Drop pleasantries and restated context. Write it as plain notes, ' +
        'not prose -- this replaces your own memory of these turns, so be complete about anything you would ' +
        'otherwise need to look back at.',
      messages: [{ role: 'user', content: transcript.slice(0, 200_000) }],
    });
    summaryText = text;
  } catch (err) {
    // If summarization itself fails (upstream hiccup), fail safe: keep the
    // full history rather than silently dropping it with no replacement.
    console.error('[direct chat] compaction summary failed, sending full history instead', err);
    return { messages: uiMessages, wasCompacted: false };
  }

  // Fixed (2026-07-14, real production crash): this used to be returned
  // as an extra `role: 'system'` UIMessage prepended into `messages`, which
  // -- once converted and combined with the main persona system prompt
  // that route.ts separately used to splice into the same array the same
  // way -- is exactly what the AI SDK's own `messages`/`prompt` validation
  // rejects by default (confirmed in node_modules/ai/dist/index.js:
  // "System messages are not allowed in the prompt or messages fields.
  // Use the instructions option instead."). Returning the plain summary
  // text instead lets route.ts fold it into `instructions` (which
  // explicitly supports an array of SystemModelMessage) alongside the
  // persona prompt, so a long-enough session to actually trigger
  // compaction no longer crashes every turn afterward.
  const compactionNote =
    `[Earlier conversation summary -- ${olderMessages.length} messages compacted to stay within the model's ` +
    `context window. This replaces the raw messages below; trust it as accurate history.]\n\n${summaryText}`;

  return { messages: recentMessages, wasCompacted: true, summaryText: compactionNote };
}
