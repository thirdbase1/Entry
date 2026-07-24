import { defineTool } from 'eve/tools';
import { agentChannel } from '../lib/tool-impls/agent_channel.js';

/**
 * Root-agent registration for the shared inter-agent "channel" -- see
 * lib/tool-impls/agent_channel.ts for the full rationale. Registered here
 * (not just wired into the sub-agent tool set in lib/tool-impls/agent.ts)
 * so the ROOT model itself can also publish/read a channel a delegated
 * sub-agent is watching, not just sub-agents talking to each other.
 */
export default defineTool(agentChannel as any);
