import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';

/**
 * Custom tool-impl (not eve's native `defineBashTool`) so the direct-model
 * chat route — a bare `streamText` call outside eve's runtime entirely —
 * can offer real shell access via its own `ctx.getSandbox()` (see
 * apps/web/lib/direct-chat/sandbox.ts). eve's root agent keeps using its
 * own built-in bash tool (apps/agent/agent/tools/bash.ts); this is purely
 * for tool parity on the direct-chat path, same shape as every other
 * tool-impl here.
 */
export const bash = {
  description:
    'Execute a shell command in a persistent sandbox (same one browser_use runs in). ' +
    'Use this to actually run code — e.g. `python3 script.py` after drafting it with ' +
    'python_coding, install packages with pip3/npm, inspect files, run curl, etc. ' +
    'Returns real stdout/stderr/exitCode from actual execution.',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute'),
  }),
  async execute({ command }: { command: string }, ctx: ToolExecCtx) {
    const sandbox = await ctx.getSandbox();
    const result = await sandbox.run({ command });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  },
};

bash.execute = safeExecute('bash', bash.execute) as typeof bash.execute;
