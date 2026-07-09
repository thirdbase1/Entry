import { defineAgent } from 'eve';
import { resolveModelIdForProvider } from '../../lib/model-catalog.js';

/**
 * Model-choice subagent — delegates the turn to OpenAI's GPT specifically.
 * Used when the user explicitly requests GPT/OpenAI as the preferred
 * model for a turn.
 *
 * The model id is resolved DYNAMICALLY from the live AI Gateway catalog
 * (no hardcoded model id) — always the current best-available OpenAI
 * model, so no edits are needed when a new GPT version ships.
 */
const modelId = await resolveModelIdForProvider('openai');

export default defineAgent({
  description:
    "Handles the user's turn using OpenAI's GPT model specifically. Delegate here ONLY when the turn's context explicitly requests GPT/OpenAI as the preferred model.",
  model: modelId,
});
