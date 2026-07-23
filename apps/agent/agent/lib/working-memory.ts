/**
 * Durable per-CHAT "working memory" (2026-07-18, REVERSED 2026-07-23 --
 * real user complaint: "agent share the same memory across allll chat ...
 * every chat with it own context memory"). Originally keyed by userId so
 * a note got re-injected into EVERY chat that user ever opened; that was
 * a deliberate design at the time (see the old comment this replaces),
 * but the actual live behavior it produced -- one chat's saved facts
 * silently bleeding into a totally unrelated chat's system prompt -- is
 * exactly what got flagged as a bug. Now keyed by chatId (EveChatSession.id)
 * instead: every chat gets its own isolated note, never shared with any
 * other chat, even ones from the same user. Deliberately small: capped at
 * MAX_LEN so it stays cheap to inject into this one chat's system prompt
 * in full, every turn.
 */
import { prisma } from '@entry/db';

export const WORKING_MEMORY_MAX_LEN = 4000;

export async function getWorkingMemory(chatId: string): Promise<string | null> {
  const row = await prisma.chatWorkingMemory.findUnique({ where: { chatId } });
  return row?.content ?? null;
}

export async function setWorkingMemory(chatId: string, content: string): Promise<{ content: string; truncated: boolean }> {
  const truncated = content.length > WORKING_MEMORY_MAX_LEN;
  const stored = truncated ? content.slice(0, WORKING_MEMORY_MAX_LEN) : content;
  await prisma.chatWorkingMemory.upsert({
    where: { chatId },
    create: { chatId, content: stored },
    update: { content: stored },
  });
  return { content: stored, truncated };
}
