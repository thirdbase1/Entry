import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { getWorkingMemory, setWorkingMemory, WORKING_MEMORY_MAX_LEN } from '../working-memory.js';

/**
 * Durable per-user "working memory" tool (2026-07-18, Mastra-inspired --
 * see UserWorkingMemory's schema comment for the full rationale). Lets the
 * agent save/update a short, stable set of facts about the user (name
 * spelling, preferences, ongoing projects/goals) that gets re-injected
 * into EVERY future session's system prompt verbatim (see instructions.ts),
 * instead of relying on semantic-recall search relevance or a single
 * session's own context window to resurface them.
 *
 * Deliberately a single full-replace write (like a small profile note),
 * not an appendable log -- keeps it small and current instead of growing
 * forever. The agent should read the existing note (returned by this same
 * tool with action:"read") before writing, and fold new facts into it
 * rather than only ever appending.
 */
export const rememberAboutUserTool = {
  description:
    `Save or read a short, durable "working memory" note about this user (name, preferences, ongoing projects/goals) that will be automatically shown to you at the start of every future conversation with them -- not just this one. ` +
    `Use action:"read" first to see the current note, then action:"write" with the FULL updated note (fold in new facts, don't just append) when you learn something worth remembering long-term. ` +
    `Keep it short and factual (capped at ${WORKING_MEMORY_MAX_LEN} characters) -- this is a small persistent profile, not a transcript or a place to log every message.`,
  inputSchema: z.object({
    action: z.enum(['read', 'write']).describe('"read" returns the current note; "write" replaces it entirely with `content`'),
    content: z.string().optional().describe('Required when action is "write" -- the FULL new note text (not a delta/append)'),
  }),
  async execute({ action, content }: { action: 'read' | 'write'; content?: string }, ctx: ToolExecCtx) {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId) return { error: 'No authenticated user for this session -- cannot read or save working memory.' };

    if (action === 'read') {
      const current = await getWorkingMemory(userId);
      return { note: current ?? '(empty -- nothing saved about this user yet)' };
    }

    if (!content) return { error: 'action was "write" but no `content` was provided.' };
    const { content: stored, truncated } = await setWorkingMemory(userId, content);
    return {
      ok: true,
      saved: stored,
      truncated,
      note: truncated
        ? `Saved, but your note was over ${WORKING_MEMORY_MAX_LEN} chars and got truncated -- keep it shorter next time.`
        : 'Saved. This will be shown to you automatically at the start of every future session with this user.',
    };
  },
};

rememberAboutUserTool.execute = safeExecute('remember_about_user', rememberAboutUserTool.execute) as typeof rememberAboutUserTool.execute;
