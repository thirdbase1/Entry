import { defineAgent } from 'eve';
import { resolveModelIdForProvider } from '../../lib/model-catalog.js';

/**
 * Model-choice subagent — delegates the turn to Anthropic's Claude
 * specifically. Used when the user explicitly requests Claude/Anthropic
 * as the preferred model for a turn (eve has no per-turn model override;
 * subagent delegation is the supported workaround).
 *
 * The model id is resolved DYNAMICALLY from the live AI Gateway catalog
 * (no hardcoded model id) — always the current best-available Anthropic
 * model, so no edits are needed when a new Claude version ships.
 *
 * Delegating here is a full child session (fresh history, own sandbox
 * unless declared), so its instructions re-declare the same general
 * persona as the root rather than assuming shared context.
 */
const modelId = await resolveModelIdForProvider('anthropic');

export default defineAgent({
  description:
    "Handles the user's turn using Anthropic's Claude model specifically. Delegate here ONLY when the turn's context explicitly requests Claude/Anthropic as the preferred model.",
  model: modelId,
});
