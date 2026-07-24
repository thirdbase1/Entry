import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';
import { sandboxWriteFile, sandboxReadFile } from './sandbox-file-io.js';

/**
 * ADDED (2026-07-24, "Direct Inter-Agent Channels"): every sub-agent
 * delegation (see lib/tool-impls/agent.ts) is currently a strict
 * parent -> child -> parent round trip -- two concurrently-running
 * delegated sub-agents (e.g. one drafting a frontend component, another
 * drafting the backend route it calls) have no way to hand a contract
 * (a schema, an interface, a partial result) to EACH OTHER mid-task; the
 * only path is back through the parent, which has to relay it manually
 * as a second delegation.
 *
 * This is a deliberately small, real fix rather than a speculative
 * message-bus: a shared JSON "channel" file inside the SAME sandbox the
 * parent turn and every one of its sub-agents already read/write through
 * (bash, file tools, etc.) -- so two sub-agents delegated with the same
 * `channel_id` can publish/read/append to a shared value without either
 * one seeing the other's conversation. No new infra (no queue, no
 * websocket) -- reuses the exact same sandbox file I/O every other tool
 * here already goes through (sandboxWriteFile/sandboxReadFile), so it
 * gets the same integrity checks and byte-size limits for free.
 *
 * Deliberately scoped to ONE sandbox/session (not cross-session, not
 * cross-user) -- this is for coordinating work within a single turn's
 * delegated sub-agents, not a general pub/sub system.
 */
const CHANNEL_DIR = '.agent-channels';

function channelPath(channelId: string): string {
  const safe = channelId.trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
  if (!safe) throw new Error('channel_id must contain at least one alphanumeric/underscore/dash/dot character.');
  return `${CHANNEL_DIR}/${safe}.json`;
}

export const agentChannel = {
  description:
    "Read from or write to a small shared JSON 'channel' that multiple concurrently-delegated sub-agents (or the parent and a " +
    "sub-agent) can use to hand each other structured data mid-task -- e.g. a frontend sub-agent publishing an API contract a " +
    "backend sub-agent then reads, without either one seeing the other's full conversation. Both sides just need to agree on the " +
    'same `channel_id` string ahead of time (put it in each delegated task\'s message). Scoped to this project/sandbox only.',
  inputSchema: z.object({
    channel_id: z.string().min(1).describe('Shared name both sides agree on, e.g. "api-contract" or "frontend-backend-handoff".'),
    action: z
      .enum(['read', 'write', 'append', 'list'])
      .describe(
        'read: get the current value (null if never written). write: replace the current value entirely. append: push `value` onto ' +
          'an array (creates the array if the channel is new or held something else). list: list every channel_id currently in use.'
      ),
    value: z.any().optional().describe('Required for write/append -- any JSON-serializable value (string, object, array, number, etc.).'),
  }),
  async execute(
    { channel_id, action, value }: { channel_id: string; action: 'read' | 'write' | 'append' | 'list'; value?: unknown },
    ctx: ToolExecCtx
  ) {
    if (action === 'list') {
      const sandbox = await ctx.getSandbox();
      const result = await sandbox.run({ command: `mkdir -p ${CHANNEL_DIR} && ls ${CHANNEL_DIR} 2>/dev/null` });
      const channels = result.stdout
        .split('\n')
        .filter(Boolean)
        .map(f => f.replace(/\.json$/, ''));
      return { ok: true, channels };
    }

    const path = channelPath(channel_id);

    if (action === 'read') {
      const r = await sandboxReadFile(ctx, path);
      if (!r.ok) return { ok: true, value: null, exists: false };
      try {
        return { ok: true, value: JSON.parse(r.content), exists: true };
      } catch {
        return { ok: false, error: `Channel "${channel_id}" holds non-JSON content: ${r.content.slice(0, 200)}` };
      }
    }

    if (value === undefined) {
      return { ok: false, error: `action "${action}" requires \`value\`.` };
    }

    if (action === 'write') {
      const w = await sandboxWriteFile(ctx, path, JSON.stringify(value), { encoding: 'utf8' });
      if (!w.ok) return { ok: false, error: w.error };
      return { ok: true, written: true };
    }

    // append
    const existing = await sandboxReadFile(ctx, path);
    let arr: unknown[] = [];
    if (existing.ok) {
      try {
        const parsed = JSON.parse(existing.content);
        arr = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // Existing content wasn't valid JSON — start a fresh array rather than fail the append.
        arr = [];
      }
    }
    arr.push(value);
    const w = await sandboxWriteFile(ctx, path, JSON.stringify(arr), { encoding: 'utf8' });
    if (!w.ok) return { ok: false, error: w.error };
    return { ok: true, length: arr.length };
  },
};

agentChannel.execute = safeExecute('agent_channel', agentChannel.execute) as typeof agentChannel.execute;
Object.assign(agentChannel, withAgentTimeout('agent_channel', agentChannel, 30_000));
