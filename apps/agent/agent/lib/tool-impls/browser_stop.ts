import { z } from 'zod';
import { prisma } from '@entry/db';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { stopBrowserUseSession, type BrowserUseSlot } from '../browser-use-cloud-client.js';
import { stopSteelSession } from '../steel-client.js';

/**
 * ADDED (2026-07-16) alongside browser_use.ts's rewrite -- explicit user
 * request: "the agent should be able to stop the browser and start."
 * browser_use already handles "start" (a fresh session_id-less call) and
 * "continue" (session_id follow-up); this is the other half. Frees the
 * session's slot so a new browser_use call without session_id can
 * immediately claim it, and ends the actual live cloud browser so it
 * isn't left running/billing idle.
 *
 * FIXED (2026-07-16): a dynamic `import('../steel-client.js')` here made
 * eve's bundler fail outright ("Failed to bundle authored module") --
 * its tool bundler only follows static imports. Matches browser_use.ts's
 * own (already-working) static import of the same module.
 */
export const browserStop = {
  description:
    'Stop a live cloud browser session previously started by browser_use. By default ends it outright and frees its ' +
    'slot for a new session. Pass cancel_task_only=true to instead just cancel whatever is currently running while ' +
    "keeping the browser itself alive (same cookies/login/tabs) so a follow-up browser_use call with the same " +
    'session_id can immediately reuse it -- only supported on Browser Use Cloud sessions (Steel sessions always stop ' +
    'outright since Steel has no task-only-cancel concept).',
  inputSchema: z.object({
    session_id: z.string().describe('The browser session id to stop (the session_id returned by a previous browser_use call).'),
    cancel_task_only: z
      .boolean()
      .optional()
      .describe('If true, only cancel the current task and keep the session alive/idle for reuse (Browser Use Cloud sessions only). Defaults to false (stop the session entirely).'),
  }),
  async execute({ session_id, cancel_task_only }: { session_id: string; cancel_task_only?: boolean }, ctx: ToolExecCtx) {
    const chatId = ctx.session.id;
    const row = await prisma.chatBrowserSession.findUnique({ where: { id: session_id } });
    if (!row || row.chatId !== chatId) {
      throw new Error(`No browser session "${session_id}" found for this chat.`);
    }
    if (row.status === 'stopped') {
      return { stopped: true, alreadyStopped: true, sessionId: session_id };
    }
    const taskOnly = Boolean(cancel_task_only) && row.provider !== 'steel';
    try {
      if (row.provider === 'steel') {
        await stopSteelSession(row.providerSessionId);
      } else {
        await stopBrowserUseSession(row.slot as BrowserUseSlot, row.providerSessionId, taskOnly ? 'task' : 'session');
      }
    } catch (err) {
      void err; // provider-side stop failures shouldn't block freeing the local slot
    }
    if (taskOnly) {
      await prisma.chatBrowserSession.update({ where: { id: row.id }, data: { status: 'idle' } });
      return { stopped: false, taskCancelled: true, sessionId: session_id };
    }
    await prisma.chatBrowserSession.update({ where: { id: row.id }, data: { status: 'stopped' } });
    return { stopped: true, sessionId: session_id };
  },
};

browserStop.execute = safeExecute('browser_stop', browserStop.execute) as typeof browserStop.execute;
