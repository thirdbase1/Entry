import { defineInstructions } from 'eve/instructions';
import { buildPersonaInstructions } from '../../lib/persona.js';

/**
 * Shared persona, no routing block — this agent is a leaf (it answers,
 * it doesn't route). Kept in sync with root and its sibling subagents via
 * the one shared buildPersonaInstructions() function instead of a hand-
 * copied file, so prompt changes can't drift between them again.
 */
export default defineInstructions({
  markdown: buildPersonaInstructions(),
});
