import { defineTool } from 'eve/tools';
import { agentDelegate } from '../lib/tool-impls/agent.js';

/**
 * Named exactly `agent.ts` so eve registers it under the `agent` slug,
 * which — per eve/docs/subagents.mdx — takes priority over eve's built-in
 * `agent` tool (fixed `{message, outputSchema?}`, no per-call model
 * choice). See lib/tool-impls/agent.ts for the full rationale.
 */
export default defineTool(agentDelegate as any);
