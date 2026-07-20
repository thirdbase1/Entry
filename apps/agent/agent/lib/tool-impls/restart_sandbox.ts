import { z } from 'zod';
import { prisma } from '@entry/db';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';

/**
 * "Make sure the agent can restart it itself in case of an error." For
 * the eve-default path this tool IS the restart mechanism — there's no
 * external handle to kill/recreate the actual VM from outside a turn (see
 * get_preview_url.ts's file comment), so this restarts what's actually
 * within reach and useful in practice: the dev server + tunnel processes
 * running inside it, which is what "the preview is broken/stuck" almost
 * always means in the first place. If the sandbox VM itself is wedged
 * (not just the process), eve's own resume/timeout handling recycles it
 * on the next turn regardless — this tool can't and doesn't need to
 * override that.
 */
export const restartSandboxTool = {
  description:
    'Restart the dev server and preview tunnel in your sandbox — use this if the preview looks broken, ' +
    'stuck, or is showing stale content, or if the user reports an error and asks you to restart it.',
  inputSchema: z.object({
    command: z
      .string()
      .optional()
      .describe('Optional: the command to restart the dev server with, e.g. "npm run dev". If omitted, only kills stuck processes/tunnels.'),
  }),
  async execute({ command }: { command?: string }, ctx: ToolExecCtx) {
    const chatId = ctx.session.id;
    const sandbox = await ctx.getSandbox();

    await sandbox.run({
      command: 'pkill -f localtunnel 2>/dev/null; pkill -f "npm run dev" 2>/dev/null; pkill -f vite 2>/dev/null; true',
    });
    await prisma.chatPreview.upsert({
      where: { chatId },
      create: { chatId, status: 'starting' },
      update: { status: 'starting', url: null, errorMessage: null },
    });

    if (command) {
      // Fire-and-forget in the background — dev servers don't exit, so we
      // can't await them. Caller should follow up with get_preview_url
      // once it's had a moment to bind its port.
      await sandbox.run({ command: `nohup ${command} > /tmp/.devserver.log 2>&1 & sleep 1` });
      // Remembered so a future restart (this tool, or the preview panel's
      // own Restart button on the BYOK path — see restartSandboxForChat)
      // can replay the same command without the model needing to repeat
      // itself. Best-effort; never worth failing the restart over.
      await prisma.chatPreview.update({ where: { chatId }, data: { lastServeCommand: command } }).catch(() => {});
    }

    return {
      ok: true,
      note: command
        ? 'Restarted. Wait a few seconds, then call get_preview_url to refresh the public preview link.'
        : 'Killed any stuck dev server/tunnel processes. Start your dev server again, then call get_preview_url.',
    };
  },
};

restartSandboxTool.execute = safeExecute('restart_sandbox', restartSandboxTool.execute) as typeof restartSandboxTool.execute;
Object.assign(restartSandboxTool, withAgentTimeout('restart_sandbox', restartSandboxTool));
