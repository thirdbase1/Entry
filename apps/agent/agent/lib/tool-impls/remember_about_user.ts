import { z } from 'zod';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';
import { getWorkingMemory, setWorkingMemory, WORKING_MEMORY_MAX_LEN } from '../working-memory.js';

/**
 * Durable per-CHAT working memory tool (2026-07-18, Mastra-inspired --
 * see ChatWorkingMemory's schema comment for the full rationale).
 * REVERSED 2026-07-23 (real complaint: "agent share the same memory
 * across allll chat ... every chat with it own context memory") from
 * per-user to per-chat: this note is now scoped to THIS ONE chat
 * (ctx.session.id) and is never shown in any other chat, even other
 * chats from the same user. Lets the agent save/update a short, stable
 * set of facts relevant to this conversation (ongoing project details,
 * decisions made, preferences stated in this chat) that gets re-injected
 * into every future turn of THIS SAME chat's system prompt verbatim (see
 * instructions.ts / direct-chat-core.ts), instead of relying on this
 * chat's own context window alone to keep resurfacing them turn after
 * turn.
 *
 * Deliberately a single full-replace write (like a small profile note),
 * not an appendable log -- keeps it small and current instead of growing
 * forever. The agent should read the existing note (returned by this same
 * tool with action:"read") before writing, and fold new facts into it
 * rather than only ever appending.
 */
export const rememberAboutUserTool = {
  description:
    `Save or read a short, durable "working memory" note for THIS CHAT (ongoing project details, decisions, preferences stated here) that will be automatically shown to you at the start of every future turn in this same conversation -- it is NOT shared with any other chat. ` +
    `Use action:"read" first to see the current note, then action:"write" with the FULL updated note (fold in new facts, don't just append) when you learn something worth remembering for the rest of this chat. ` +
    `Keep it short and factual (capped at ${WORKING_MEMORY_MAX_LEN} characters) -- this is a small persistent note for this conversation, not a transcript or a place to log every message.`,
  inputSchema: z.object({
    action: z.enum(['read', 'write']).describe('"read" returns the current note; "write" replaces it entirely with `content`'),
    content: z.string().optional().describe('Required when action is "write" -- the FULL new note text (not a delta/append)'),
  }),
  async execute({ action, content }: { action: 'read' | 'write'; content?: string }, ctx: ToolExecCtx) {
    const chatId = ctx.session.id;
    if (!chatId) return { error: 'No chat id on this session -- cannot read or save working memory.' };

    if (action === 'read') {
      const current = await getWorkingMemory(chatId);
      return { note: current ?? '(empty -- nothing saved in this chat yet)' };
    }

    if (!content) return { error: 'action was "write" but no `content` was provided.' };
    const { content: stored, truncated } = await setWorkingMemory(chatId, content);
    return {
      ok: true,
      saved: stored,
      truncated,
      note: truncated
        ? `Saved, but your note was over ${WORKING_MEMORY_MAX_LEN} chars and got truncated -- keep it shorter next time.`
        : 'Saved. This will be shown to you automatically at the start of every future turn in this chat (not in other chats).',
    };
  },
};

rememberAboutUserTool.execute = safeExecute('remember_about_user', rememberAboutUserTool.execute) as typeof rememberAboutUserTool.execute;
Object.assign(rememberAboutUserTool, withAgentTimeout('remember_about_user', rememberAboutUserTool));
