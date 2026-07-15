import type { UIMessage } from 'ai';

/**
 * Strips `reasoning` parts out of every message's `parts` array.
 *
 * Why this exists (2026-07-16, real bug traced from a chat log: BYOK
 * provider using OPENAI_RESPONSES compatibility mode against a
 * third-party relay — e.g. Kie.ai's `/grok/v1/responses` proxy for
 * grok-4.5 — answers fine on turn 1, then goes completely dead on turn 2
 * of the SAME chat: finishReason 'other', zero tool calls, zero text,
 * and every usage field `undefined`, no thrown error anywhere).
 *
 * Root cause, confirmed directly in
 * node_modules/@ai-sdk/openai/src/responses/convert-to-openai-responses-input.ts:
 * turn 1's reasoning output part carries whatever `id` the relay put on
 * its `type: "reasoning"` item (Kie.ai's grok-4.5 output does include one,
 * e.g. "rs_3a5c749b-...", same shape as real OpenAI). @ai-sdk/openai's
 * `.responses()` input converter reads that id back off
 * `part.providerOptions.itemId` on the NEXT turn and re-sends it as part
 * of a stateful reasoning item (an `item_reference`, or — when `store` is
 * false, as it is here — a `{ type: 'reasoning', id, encrypted_content:
 * undefined, summary }` object) assuming the SAME id can be resolved
 * server-side, exactly like real OpenAI's actual Responses API supports.
 * A relay like Kie.ai's, proxying xAI's Grok (which recomputes reasoning
 * fresh every turn and has no such item store at all), has no way to
 * resolve that foreign id — and instead of rejecting the malformed
 * request with a clear error, it silently returns a response with no
 * output and no usage stats, which is indistinguishable from the model
 * having simply stopped.
 *
 * The fix: for exactly this case (isThirdPartyResponsesRelay, see
 * resolve-model.ts), never let a previous turn's reasoning parts re-enter
 * the request in the first place — treat every turn's reasoning as
 * fresh/disposable, matching how these relays' real backends actually
 * work. This only affects what gets SENT to the model for this one
 * relay's turns; the persisted `uiMessages` (and therefore what the UI
 * itself renders, including any past "Thinking" content) is untouched.
 */
export function stripReasoningParts(messages: UIMessage[]): UIMessage[] {
  return messages.map(message => {
    if (!Array.isArray(message.parts) || !message.parts.some(p => p.type === 'reasoning')) {
      return message;
    }
    return { ...message, parts: message.parts.filter(p => p.type !== 'reasoning') };
  });
}
