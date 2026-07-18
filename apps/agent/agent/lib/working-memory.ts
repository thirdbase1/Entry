/**
 * Durable per-user "working memory" (2026-07-18) -- see UserWorkingMemory's
 * schema comment (packages/db/prisma/schema.prisma) for why this is its own
 * layer instead of folding into chat embeddings or eve's in-session
 * compaction. Deliberately small: capped at MAX_LEN so it stays cheap to
 * inject into every session's system prompt in full, every time.
 */
import { prisma } from '@entry/db';

export const WORKING_MEMORY_MAX_LEN = 4000;

export async function getWorkingMemory(userId: string): Promise<string | null> {
  const row = await prisma.userWorkingMemory.findUnique({ where: { userId } });
  return row?.content ?? null;
}

export async function setWorkingMemory(userId: string, content: string): Promise<{ content: string; truncated: boolean }> {
  const truncated = content.length > WORKING_MEMORY_MAX_LEN;
  const stored = truncated ? content.slice(0, WORKING_MEMORY_MAX_LEN) : content;
  await prisma.userWorkingMemory.upsert({
    where: { userId },
    create: { userId, content: stored },
    update: { content: stored },
  });
  return { content: stored, truncated };
}
