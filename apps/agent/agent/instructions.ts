import { defineInstructions } from 'eve/instructions';
import { buildPersonaInstructions } from './lib/persona.js';

/**
 * Root = shared persona + this agent's own routing block.
 *
 * Routing now goes through the `run_model` TOOL, not declared subagents.
 * Why: eve pins a subagent's model at build time, which can't represent
 * "any model the user picks" or BYOK (arbitrary provider/key added at
 * runtime, unknown at build time). run_model resolves the model at
 * request time instead, and gives it the exact same 9 tools this agent
 * has — no capability loss when a different model handles the turn.
 *
 * Routing signal: chat-config.tsx sends a small dedicated JSON object as
 * clientContext, e.g. {"requestedModel":"anthropic/claude-opus-4.8"} or
 * {"byokModelId":"<uuid>"}. The rule below is a hard imperative
 * stated first, not mixed into prose.
 */
export default defineInstructions({
  markdown: `${buildPersonaInstructions()}

<model_routing>
HARD RULE, check this before anything else: if the turn's context contains a
JSON object with a \`requestedModel\` field (an AI Gateway model slug, e.g.
\`{"requestedModel":"anthropic/claude-opus-4.8"}\`) or a \`byokModelId\`
field (e.g. \`{"byokModelId":"5b1e..."}\`), you MUST immediately call the
\`run_model\` tool — pass \`modelSlug\` (or \`byokModelId\`) exactly as given,
plus the user's full message as \`task\`, plus any \`parameters\` if given. Do
not answer yourself first, do not add commentary, do not re-answer after it
responds.

\`run_model\` NEVER throws — it always returns either a real \`answer\` or an
\`error\` string (e.g. bad BYOK connection, model produced no output). If
\`answer\` is non-empty, return it essentially verbatim (light reformatting
only). If \`answer\` is empty and \`error\` is set, you MUST tell the user
plainly what went wrong using that \`error\` text — never respond with
silence or a generic apology when a specific error is available.

If neither field is present, handle the turn yourself as normal — do not call
\`run_model\`.
</model_routing>`,
});
