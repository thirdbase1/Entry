/**
 * Pure event-log -> transcript-text extraction, shared by the chat
 * embedding job (embedding/service.ts's embedChat) and mirrored (not
 * imported, see chat-context.tsx's header note on why) by the client-side
 * context-attachment resolver.
 *
 * Verified directly against eve's real shipped types
 * (node_modules/eve/dist/src/protocol/message.d.ts) rather than assumed:
 * user turns are `{ type: 'message.received', data: { message: string } }`
 * and assistant turns are `{ type: 'message.completed', data: { message:
 * string | null } }` — flat strings, NOT `{ message: { role, parts } }`.
 * (That wrong shape was actually in production in chat-context.tsx's
 * `resolveContextForSend` until this session — it filtered/mapped fields
 * that don't exist on the real event objects, so attaching a prior chat as
 * context silently always resolved to empty text. Fixed here.)
 */
export interface ChatTextEvent {
  type?: string;
  data?: { message?: string | null };
}

/** Builds a `"role: content"` transcript from a persisted event-log snapshot, mirroring the original's `messages.map(m => \`${m.role}: ${m.content}\`).join('\n')`. */
export function extractChatText(events: unknown, limit?: number): string {
  if (!Array.isArray(events)) return '';

  const turns = (events as ChatTextEvent[])
    .filter(e => e?.type === 'message.received' || e?.type === 'message.completed')
    .map(e => {
      const role = e.type === 'message.received' ? 'user' : 'assistant';
      const text = e?.data?.message;
      return typeof text === 'string' && text.trim() ? `${role}: ${text.trim()}` : null;
    })
    .filter((line): line is string => Boolean(line));

  const scoped = limit ? turns.slice(-limit) : turns;
  return scoped.join('\n');
}
