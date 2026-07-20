import type { UIMessage } from 'ai';

/**
 * Repairs any assistant tool-call parts left "dangling" (no matching
 * result) in a persisted/incoming UIMessage[] history, by rewriting them
 * to a completed `output-error` state with a synthetic error message.
 *
 * Why this exists (2026-07-11, real production incident): the `ai`
 * package's own prompt conversion (invoked by `convertToModelMessages`,
 * confirmed directly in node_modules/ai/dist/index.js's
 * convertToLanguageModelPrompt) throws `AI_MissingToolResultsError` the
 * instant it finds an assistant tool-call part with no matching
 * tool-result part anywhere later in the message list — and it does this
 * BEFORE the model is ever called. From the user's side this looks
 * exactly like "I sent a message and the agent stopped instantly with no
 * response at all" — there's no partial answer, no streaming, nothing,
 * because the request never even reaches the model.
 *
 * A tool call can end up dangling in persisted history several ways: the
 * connection dropped mid-tool-execution before its result part was ever
 * produced/persisted, a tool's `execute` itself hung or threw somewhere
 * that skipped the normal result-writing path, or (confirmed real case
 * that day) an older, broken tool implementation never resolved at all.
 * Whatever the cause, once a message like that is saved, EVERY subsequent
 * turn in that same chat resends the full history and immediately hits
 * the same wall forever — the conversation is permanently bricked until
 * something repairs that one message.
 *
 * This is the general-purpose repair: called on incoming history right
 * before `convertToModelMessages` (so an already-broken chat heals itself
 * on the very next turn instead of staying stuck), and again on
 * `onFinish`'s `finalMessages` right before persisting (so a turn cut off
 * mid-tool-call this time doesn't leave the same trap for the next one).
 */
export function sanitizeDanglingToolCalls(messages: UIMessage[]): UIMessage[] {
  const danglingStates = new Set(['input-streaming', 'input-available', 'approval-requested', 'approval-responded']);

  return messages.map(message => {
    if (message.role !== 'assistant' || !Array.isArray(message.parts)) return message;

    let messageMutated = false;
    const newParts = message.parts.map((part: any) => {
      const isToolPart = typeof part?.type === 'string' && (part.type.startsWith('tool-') || part.type === 'dynamic-tool');
      if (!isToolPart || !danglingStates.has(part.state)) return part;

      messageMutated = true;
      return {
        ...part,
        state: 'output-error',
        input: part.input ?? {},
        output: undefined,
        errorText:
          'Tool call was interrupted before it completed (connection dropped or the run never finished) — no result is available.',
      };
    });

    return messageMutated ? { ...message, parts: newParts } : message;
  });
}
