import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';

export const browserUse = {
  description:
    'Autonomously drive a real Chrome browser to complete a task: navigate, click, fill forms, ' +
    'read page content, take screenshots. Give it a natural-language task description; it plans ' +
    'and executes the necessary browser steps itself and returns a markdown summary of what it found/did.',
  inputSchema: z.object({
    task: z.string().describe('Natural-language description of what the browser should accomplish'),
  }),
  async execute({ task }: { task: string }, ctx: ToolExecCtx) {
    const sandbox = await ctx.getSandbox();
    const result = await sandbox.run({
      command: `agent-browser --session ${sandbox.id} chat ${JSON.stringify(task)} --json`,
    });
    if (result.exitCode !== 0) {
      throw new Error(`agent-browser chat failed: ${result.stderr}`);
    }
    return { result: result.stdout };
  },
};

browserUse.execute = safeExecute('browser_use', browserUse.execute) as typeof browserUse.execute;
