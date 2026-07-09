import { defineAgent } from 'eve';
import { resolveModelIdForProvider } from '../../lib/model-catalog.js';

/**
 * Model-choice subagent — delegates the turn to Google's Gemini
 * specifically. Used when the user explicitly requests Gemini/Google
 * as the preferred model for a turn.
 *
 * The model id is resolved DYNAMICALLY from the live AI Gateway catalog
 * (no hardcoded model id) — always the current best-available Google
 * model, so no edits are needed when a new Gemini version ships.
 */
const modelId = await resolveModelIdForProvider('google');

export default defineAgent({
  description:
    "Handles the user's turn using Google's Gemini model specifically. Delegate here ONLY when the turn's context explicitly requests Gemini/Google as the preferred model.",
  model: modelId,
});
