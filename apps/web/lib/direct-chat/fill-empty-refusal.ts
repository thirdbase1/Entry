import type { UIMessage } from 'ai';

/**
 * Confirmed real bug (2026-07-17, from production logs): a turn can finish
 * with `finishReason: 'content-filter'` (`rawFinishReason: 'refusal'` for
 * Anthropic) and ZERO text, ZERO tool calls — the model declined to answer
 * at all, on step 0, before producing anything. The AI SDK does not treat
 * this as an "error" (no exception is thrown, `onError` never fires), so
 * without this fix the assistant's message in both the live stream AND the
 * persisted chat history ends up with an empty `parts` array. From the
 * user's side that's total silence: the "Thinking…" indicator disappears
 * (turn is no longer busy) and nothing ever appears in its place — no
 * error, no explanation, not even an empty bubble to look at.
 *
 * This gives the user an honest, visible reason instead of dead air.
 * Applied in two independent places in route.ts (both use this same text
 * so a page refresh shows the identical message the user already saw
 * live): (1) wrapping the live UI message stream, appended as real
 * text-start/text-delta/text-end chunks only if nothing else was ever
 * emitted; (2) in the persistence `onFinish`, appended as a plain
 * TextUIPart on the last assistant message before saving, under the same
 * "nothing else is there" condition.
 */
export function describeRefusal(finishReason: string | undefined, rawFinishReason: string | undefined): string {
  const isContentFilter = finishReason === 'content-filter' || rawFinishReason === 'refusal';
  if (isContentFilter) {
    return (
      "The model declined to respond to this message (content filter / refusal) and returned no output at all. " +
      "This is coming from the provider's own safety filtering, not an app error — try rephrasing your message, " +
      "or switch to a different model if this keeps happening."
    );
  }
  // This branch only ever runs when there is truly no text, no tool
  // call, AND no error part at all (hasRealContent's error check above
  // now catches every case where a real, specific reason exists) -- so
  // this genuinely is the rare "provider returned nothing, no exception
  // thrown" case, not a mask over a real error.
  const reasonLabel = rawFinishReason || finishReason;
  return (
    `No response came back this turn${reasonLabel ? ` (provider reported: ${reasonLabel})` : ' and the provider did not report a reason'}. ` +
    'Try again, or rephrase your message.'
  );
}

function hasRealContent(message: UIMessage): boolean {
  if (!Array.isArray(message.parts)) return false;
  return message.parts.some((part: any) => {
    if (part?.type === 'text') return typeof part.text === 'string' && part.text.trim().length > 0;
    if (typeof part?.type === 'string' && (part.type.startsWith('tool-') || part.type === 'dynamic-tool')) return true;
    // FIXED (2026-07-22, real user report: a genuine error -- e.g. "your
    // saved API key could not be read" -- was getting buried under the
    // generic "finished without returning any text" fallback below,
    // because a real `{ type: 'error', errorText }` part was never
    // recognized as "content" here. That's backwards: an error IS the
    // real, specific, actionable explanation -- it must never be treated
    // as silence and papered over with a vague generic message.
    if (part?.type === 'error' && typeof part.errorText === 'string' && part.errorText.trim().length > 0) return true;
    return false;
  });
}

/**
 * Mutates-in-effect (returns a new array, doesn't touch the input) a
 * persisted UIMessage[] history: if the LAST message is an assistant
 * message with no real content at all, appends a synthetic text part
 * explaining why, using the same wording the live stream already showed.
 */
export function fillEmptyAssistantReply(
  messages: UIMessage[],
  finishReason: string | undefined,
  rawFinishReason: string | undefined
): UIMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== 'assistant' || hasRealContent(last)) return messages;

  const fallbackText = describeRefusal(finishReason, rawFinishReason);
  const patched: UIMessage = {
    ...last,
    parts: [...(Array.isArray(last.parts) ? last.parts : []), { type: 'text', text: fallbackText, state: 'done' }],
  };
  return [...messages.slice(0, -1), patched];
}
