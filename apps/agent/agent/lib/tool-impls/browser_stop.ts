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
  description: 'Stop a live cloud browser session previously started by browser_use, ending it and freeing its slot for a new session.',
  inputSchema: z.object({
    session_id: z.string().describe('The browser session id to stop (the session_id returned by a previous browser_use call).'),
  }),
  async execute({ session_id }: { session_id: string }, ctx: ToolExecCtx) {
    const chatId = ctx.session.id;
    const row = await prisma.chatBrowserSession.findUnique({ where: { id: session_id } });
    if (!row || row.chatId !== chatId) {
      throw new Error(`No browser session "${session_id}" found for this chat.`);
    }
    if (row.status === 'stopped') {
      return { stopped: true, alreadyStopped: true, sessionId: session_id };
    }
    try {
      if (row.provider === 'steel') {
        await stopSteelSession(row.providerSessionId);
      } else {
        await stopBrowserUseSession(row.slot as BrowserUseSlot, row.providerSessionId);
      }
    } catch (err) {
      void err; // provider-side stop failures shouldn't block freeing the local slot
    }
    await prisma.chatBrowserSession.update({ where: { id: row.id }, data: { status: 'stopped' } });
    return { stopped: true, sessionId: session_id };
  },
};

browserStop.execute = safeExecute('browser_stop', browserStop.execute) as typeof browserStop.execute;
