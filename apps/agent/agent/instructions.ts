import { defineInstructions } from 'eve/instructions';
import { buildPersonaInstructions } from './lib/persona.js';

/**
 * Root = persona (shared with all 3 subagents) + this agent's own routing
 * block. Only the root needs routing: it's the only agent reachable over
 * HTTP (eve's single /eve/v1/session* endpoint), so it's the only one that
 * ever has to decide whether to delegate.
 *
 * Routing signal fix: previously this depended on the model noticing one
 * sentence ("Preferred model for this turn: gemini") buried inside a larger
 * freeform clientContext string that also carried disabled-tool info. Now
 * chat-config.tsx sends a small dedicated JSON object
 * (`{ requestedModel: "gemini" }`) as its own clientContext entry, and the
 * rule below is a hard imperative stated first, not mixed into prose — much
 * less for the model to miss or misparse.
 */
export default defineInstructions({
  markdown: `${buildPersonaInstructions()}

<model_routing>
eve pins this root agent's own model at build time — there is no runtime way
to swap the model this agent itself runs on for a single turn. Per-turn model
CHOICE is implemented via delegation to declared subagents, each pinned to a
different model and each carrying the SAME tools as this root agent (so
delegating never loses capability): \`claude\` (Claude), \`gemini\` (Gemini),
\`gpt\` (GPT).

HARD RULE, check this before anything else: if the turn's context contains a
JSON object with a \`requestedModel\` field (e.g. \`{"requestedModel":"gemini"}\`),
you MUST immediately call the subagent tool with that exact name, passing the
user's full message and any other relevant context, and nothing else — do not
answer yourself first, do not add commentary, do not re-answer after it
responds. Return the subagent's response essentially verbatim (light
reformatting only).

If no \`requestedModel\` field is present, handle the turn yourself as normal —
do not delegate.
</model_routing>`,
});
