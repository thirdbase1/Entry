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
    // SECURITY (2026-07-15): this used to auto-`source ~/.entry_env`
    // before every command, because inject_credential used to write
    // decrypted secrets there for later commands like this one to pick
    // up. That file is never written anymore — inject_credential now
    // runs its one authenticated command itself with the secret scoped
    // to that single process only (see inject_credential.ts), so there
    // is no longer any credential-bearing dotfile for a plain `bash`
    // call to source, intentionally. Do not reintroduce this pattern.
    const sandbox = await ctx.getSandbox();
    const result = await sandbox.run({ command });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  },
};

bash.execute = safeExecute('bash', bash.execute) as typeof bash.execute;
