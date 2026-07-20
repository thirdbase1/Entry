import { z } from 'zod';
import { CommandExitError } from 'e2b';
import { prisma } from '@entry/db';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withTimeoutSignal } from './with-timeout-signal.js';
import { DEFAULT_TOOL_TIMEOUT_MS } from './with-agent-timeout.js';
import { withPeriodicVersionCapture } from '@entry/db/chat-versioning';

/**
 * Best-effort capture of "the command that's actually serving something
 * long-running" (2026-07-16, real bug: clicking Restart in the preview
 * panel used to destroy the whole sandbox filesystem just to have SOME
 * sandbox left to run a dev server in -- see restartSandboxForChat's file
 * comment in apps/web/lib/direct-chat/sandbox.ts for the full fix). A
 * command backgrounded with `nohup ... &` / a trailing `&` is exactly the
 * pattern this codebase already tells the model to use for dev servers
 * (see this tool's own description below), so it's a reliable-enough
 * signal without trying to pattern-match specific frameworks (npm run
 * dev, vite, next dev, python -m http.server, etc. all look different).
 * Last one wins -- if the model restarts a server with a new command,
 * that's the one worth replaying next time, not the first one it ever
 * tried.
 */
const BACKGROUNDED_COMMAND = /nohup\s|&\s*$/;
async function maybeRememberServeCommand(chatId: string, command: string): Promise<void> {
  if (!BACKGROUNDED_COMMAND.test(command.trim())) return;
  await prisma.chatPreview
    .upsert({
      where: { chatId },
      create: { chatId, status: 'stopped', lastServeCommand: command },
      update: { lastServeCommand: command },
    })
    .catch(() => {
      // Best-effort — a missed capture just means a future Restart click
      // can't auto-replay this particular command; never worth failing
      // the actual bash call over.
    });
}

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
 * actually run long.
 *
 * BUMPED 120s -> 240s (2026-07-18, user-reported: a real clone+install+
 * audit+build+commit pipeline run as ONE command legitimately needed more
 * than 120s and kept hitting this ceiling, forcing the model into a
 * nohup-background-and-poll workaround just to get a normal `npm
 * install` to finish — and the user correctly pointed out the actual
 * platform ceiling is 300s (Vercel Hobby plan's maxDuration, see
 * direct/chat/route.ts), not 120s. 240s keeps a real 60s buffer under
 * that 300s ceiling for model overhead and any other tool call in the
 * same turn, while giving genuine multi-step pipelines roughly double
 * the previous headroom. The underlying sandbox itself already supports
 * up to 300s per command as a separate, lower-priority safety net (see
 * direct-chat/sandbox.ts's own `run()`) — this constant was the actual
 * artificial ceiling, not the sandbox. Anything that still needs more
 * than this should keep using `nohup ... &` (see restart_sandbox.ts for
 * the pattern this codebase already uses elsewhere) rather than pushing
 * this number any closer to 300s.
 */
// BUMPED again 240s -> 600s/10min default, model-overridable (2026-07-20,
// "bump the limit of everything up to 10 minutes by default", moving off
// Vercel serverless onto the standalone worker -- the 240s ceiling above
// existed only to leave a buffer under Vercel Hobby's 300s maxDuration,
// which doesn't apply to a persistent worker process. `timeout_seconds`
// on the input below lets the model ask for more or less per call.
const TIMEOUT_MS = DEFAULT_TOOL_TIMEOUT_MS;

export const bash = {
  description:
    'Execute a shell command in a persistent sandbox (same one browser_use runs in). ' +
    'Use this to actually run code — e.g. `python3 script.py` after drafting it with ' +
    'python_coding, install packages with pip3/npm, inspect files, run curl, etc. ' +
    'Returns real stdout/stderr/exitCode from actual execution. Commands have a 10-minute default ceiling (override with `timeout_seconds`) — ' +
    'for anything longer-running (dev servers, long builds), background it with `nohup cmd > /tmp/out.log 2>&1 &` ' +
    'instead of running it directly.',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute'),
    timeout_seconds: z
      .number()
      .int()
      .positive()
      .max(3600)
      .optional()
      .describe('Optional override for how long this command may run, in seconds. Defaults to 600s (10 min) if omitted.'),
  }),
  async execute({ command, timeout_seconds }: { command: string; timeout_seconds?: number }, ctx: ToolExecCtx) {
    // SECURITY (2026-07-15): this used to auto-`source ~/.entry_env`
    // before every command, because inject_credential used to write
    // decrypted secrets there for later commands like this one to pick
    // up. That file is never written anymore — inject_credential now
    // runs its one authenticated command itself with the secret scoped
    // to that single process only (see inject_credential.ts), so there
    // is no longer any credential-bearing dotfile for a plain `bash`
    // call to source, intentionally. Do not reintroduce this pattern.
    const sandbox = await ctx.getSandbox();
    void maybeRememberServeCommand(ctx.session.id, command);
    const effectiveTimeoutMs = typeof timeout_seconds === 'number' && timeout_seconds > 0 ? timeout_seconds * 1000 : TIMEOUT_MS;
    const t = withTimeoutSignal(ctx.abortSignal, effectiveTimeoutMs, 'bash');
    try {
      // Periodic in-flight version capture (2026-07-18, "improve sandbox
      // saving x6") -- see withPeriodicVersionCapture's own doc comment.
      // Bash is the one tool most likely to run long enough for this to
      // matter (builds, installs, multi-step pipelines run as one call).
      // Interval tightened 30s -> 10s (2026-07-18, user-requested "x5
      // improvement" on top of the per-step capture already in place) --
      // see withPeriodicVersionCapture's own doc comment in
      // chat-versioning.ts for why this exists at all. A command that
      // finishes in under 10s still costs nothing extra (the interval
      // never fires once, cleared immediately on completion either way).
      const result = await withPeriodicVersionCapture(ctx.session.id, sandbox, () => sandbox.run({ command, signal: t.signal }), 10_000);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } catch (err) {
      // FIXED (2026-07-18, real bug: "signal: terminated" surfacing as a
      // bare, unexplained error with stdout/stderr silently dropped).
      // E2B's own `commands.run()` (see node_modules/e2b's Commands.run ->
      // CommandHandle.wait()) throws `CommandExitError` for ANY non-zero
      // exit code -- not just crashes, but completely ordinary shell
      // control flow too (`grep` finding nothing, a failing `test`, a
      // linter reporting issues, etc.). Every one of those was silently
      // losing its actual stdout/stderr and collapsing into a generic
      // "bash failed: <message>" the model had zero ability to reason
      // about -- it never even saw what the command printed before
      // failing. Root-caused the specific "signal: terminated" variant
      // too: that exact string is Go's `os.ProcessState.String()` format
      // for a process killed by SIGTERM (confirmed via e2b's envd being
      // Go-based) -- i.e. the sandbox's own supervisor killed the
      // process mid-run, most likely hitting the 2GB template's memory
      // ceiling on a heavy chained command (`a && b && c`), since our own
      // 240s tool timeout already gets a distinct, friendly message via
      // `t.rethrow` before this branch is ever reached.
      if (err instanceof CommandExitError) {
        const killedBySignal = /^signal:/i.test(err.error ?? '');
        const note = killedBySignal
          ? `\n[process terminated by signal -- likely killed for using too much memory (2GB sandbox limit) or an internal timeout. ` +
            `If this was a chained command (a && b && c), split it into separate bash calls run one at a time instead of one long chain -- ` +
            `that way a failure doesn't wipe out the output of the steps that already ran, and each step gets its own resource headroom.]`
          : '';
        return { stdout: err.stdout, stderr: (err.stderr ?? '') + note, exitCode: err.exitCode };
      }
      throw t.rethrow(err);
    } finally {
      t.clear();
    }
  },
};

bash.execute = safeExecute('bash', bash.execute) as typeof bash.execute;
