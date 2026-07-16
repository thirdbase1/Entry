import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withTimeoutSignal } from './with-timeout-signal.js';

/**
 * Custom tool-impl (not eve's native `defineBashTool`) so the direct-model
 * chat route — a bare `streamText` call outside eve's runtime entirely —
 * can offer real shell access via its own `ctx.getSandbox()` (see
 * apps/web/lib/direct-chat/sandbox.ts). eve's root agent keeps using its
 * own built-in bash tool (apps/agent/agent/tools/bash.ts); this is purely
 * for tool parity on the direct-chat path, same shape as every other
 * tool-impl here.
 *
 * FIXED (2026-07-16, real bug: "agent stops itself / stays silent after a
 * tool call" reported on BYOK chats specifically running long commands).
 * This tool used to have NO timeout of its own at all — a slow/hung
 * command (npm install, a build, a stuck server foregrounded by mistake)
 * just rode along until the outer request's own maxDuration (300s,
 * direct/chat/route.ts) killed the ENTIRE turn with nothing surfaced to
 * the model or the user — the exact same class of bug already fixed for
 * code_artifact/python_coding/task_analysis via with-timeout-signal.ts,
 * just never applied here even though bash is the tool most likely to
 * actually run long. 120s leaves genuine headroom under 300s even as a
 * later tool call in a multi-step turn, while still being long enough for
 * a real `npm install`/`pip install` — anything longer should be
 * backgrounded with `nohup ... &` (see restart_sandbox.ts for the pattern
 * this codebase already uses elsewhere) rather than foregrounded here.
 */
const TIMEOUT_MS = 120_000;

export const bash = {
  description:
    'Execute a shell command in a persistent sandbox (same one browser_use runs in). ' +
    'Use this to actually run code — e.g. `python3 script.py` after drafting it with ' +
    'python_coding, install packages with pip3/npm, inspect files, run curl, etc. ' +
    'Returns real stdout/stderr/exitCode from actual execution. Commands have a 120s ceiling — ' +
    'for anything longer-running (dev servers, long builds), background it with `nohup cmd > /tmp/out.log 2>&1 &` ' +
    'instead of running it directly.',
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
    const t = withTimeoutSignal(ctx.abortSignal, TIMEOUT_MS, 'bash');
    try {
      const result = await sandbox.run({ command, signal: t.signal });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } catch (err) {
      throw t.rethrow(err);
    } finally {
      t.clear();
    }
  },
};

bash.execute = safeExecute('bash', bash.execute) as typeof bash.execute;
