/**
 * Replaces packages/ai/src/tools/browser-agent.ts. Same idea (shell out to
 * agent-browser's own native `chat` command, which is itself Gateway-
 * powered — see sandbox/sandbox.ts header comment), but simpler under eve:
 * no hand-rolled kernel/session-map needed, `ctx.getSandbox()` already
 * gives a persistent, auto-resuming sandbox scoped to this chat session,
 * with agent-browser + Chrome pre-installed via the bootstrap template.
 */
import { defineTool } from 'eve/tools';
import { z } from 'zod';

export default defineTool({
  description:
    'Autonomously drive a real Chrome browser to complete a task: navigate, click, fill forms, ' +
    'read page content, take screenshots. Give it a natural-language task description; it plans ' +
    'and executes the necessary browser steps itself and returns a markdown summary of what it found/did.',
  inputSchema: z.object({
    task: z.string().describe('Natural-language description of what the browser should accomplish'),
  }),
  async execute({ task }, ctx) {
    const sandbox = await ctx.getSandbox();
    // `sandbox.id` is stable across reconnects to the same logical session
    // (per eve's sandbox docs) — reused as agent-browser's own `--session`
    // key so cookies/tabs/auth-state persist across calls in this chat too.
    const result = await sandbox.run({
      command: `agent-browser --session ${sandbox.id} chat ${JSON.stringify(task)} --json`,
    });
    if (result.exitCode !== 0) {
      throw new Error(`agent-browser chat failed: ${result.stderr}`);
    }
    return { result: result.stdout };
  },
});
