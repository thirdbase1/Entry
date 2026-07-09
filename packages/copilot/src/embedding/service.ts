/**
 * Persistence + search for doc/file/chat embeddings, using raw SQL for the
 * pgvector `vector(1024)` columns (Prisma's generated client can't type
 * "Unsupported" columns — confirmed by reading schema.prisma directly,
 * `embedding Unsupported("vector(1024)")` — so writes/reads go through
 * `prisma.$executeRaw`/`$queryRaw` with `Prisma.sql`/`Prisma.raw`, both
 * confirmed real exports off the generated client's `Prisma` namespace).
 * Distance metric: cosine (`<=>` operator, pgvector's cosine-distance op,
 * matching OpenAI's own recommended metric for its embedding models).
 *
 * The embedding vector itself is only ever machine-generated floats (never
 * user-controlled text), so building its literal via `Prisma.raw()` here
 * is safe — no injection surface. All other values go through parameterized
 * `Prisma.sql` placeholders as usual.
 */
import { prisma, Prisma } from '@entry/db';
import { chunkText, batchChunks, isEmbeddableText } from './chunk';
import { embedBatch, embedQuery } from './client';
import { extractChatText } from './chat-text';

function toVectorLiteral(embedding: number[]): string {
  return `'[${embedding.join(',')}]'::vector`;
}

type Table = 'ai_user_doc_embeddings' | 'ai_user_file_embeddings' | 'ai_user_chat_embeddings';
type IdColumn = 'doc_id' | 'file_id' | 'session_id';

async function embedAndStore(
  table: Table,
  idColumn: IdColumn,
  userId: string,
  targetId: string,
  content: string
): Promise<{ chunkCount: number }> {
  const chunks = chunkText(content);
  if (!chunks.length) return { chunkCount: 0 };

  // Clear old chunks first — a doc/file/chat update may have fewer chunks than before.
  await prisma.$executeRaw(
    Prisma.sql`DELETE FROM ${Prisma.raw(table)} WHERE user_id = ${userId} AND ${Prisma.raw(idColumn)} = ${targetId}`
  );

  for (const batch of batchChunks(chunks)) {
    const embeddings = await embedBatch(batch.map(c => c.content));
    for (const e of embeddings) {
      const chunk = batch[e.index];
      await prisma.$executeRaw(
        Prisma.sql`INSERT INTO ${Prisma.raw(table)} (user_id, ${Prisma.raw(idColumn)}, chunk, content, embedding)
          VALUES (${userId}, ${targetId}, ${chunk.index}, ${chunk.content}, ${Prisma.raw(toVectorLiteral(e.embedding))})
          ON CONFLICT (user_id, ${Prisma.raw(idColumn)}, chunk) DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding`
      );
    }
  }
  return { chunkCount: chunks.length };
}

export async function embedDoc(userId: string, docId: string, content: string) {
  return embedAndStore('ai_user_doc_embeddings', 'doc_id', userId, docId, content);
}

export async function embedFile(userId: string, fileId: string, fileName: string, mimeType: string, buffer: Buffer) {
  if (!isEmbeddableText(mimeType)) {
    // Real, documented scope cut (see chunk.ts header) — binary formats are
    // stored (Vercel Blob) but not embedded/searchable yet.
    return { chunkCount: 0, skipped: true as const };
  }
  const text = buffer.toString('utf-8');
  return embedAndStore('ai_user_file_embeddings', 'file_id', userId, fileId, text);
}

/**
 * Embeds a chat session's transcript. Unlike the original (which read
 * `models.copilotSession.getMessages()` live from the legacy AiSession
 * table), this reads the already-persisted `EveChatSession.events` JSONB
 * snapshot directly off our own DB — no round-trip to eve's live API
 * needed, since `chats.ts`'s `saveChatSnapshot()` already writes that
 * snapshot on every turn. `extractChatText()` (chat-text.ts) turns the
 * raw event log into the same `"role: content"` transcript shape the
 * original built from its message rows.
 */
export async function embedChat(userId: string, sessionId: string) {
  const row = await prisma.eveChatSession.findFirst({
    where: { id: sessionId, userId },
    select: { events: true },
  });
  if (!row) return { chunkCount: 0, skipped: true as const };

  const text = extractChatText(row.events);
  if (!text.trim()) return { chunkCount: 0, skipped: true as const };

  return embedAndStore('ai_user_chat_embeddings', 'session_id', userId, sessionId, text);
}

export interface SearchResult {
  targetId: string;
  targetType: 'doc' | 'file' | 'chat';
  chunk: number;
  content: string;
  distance: number;
}

/** Cosine-similarity search across a user's doc + file + chat embeddings. */
export async function searchEmbeddings(userId: string, query: string, topK = 5): Promise<SearchResult[]> {
  const vector = await embedQuery(query);
  const vectorLiteral = toVectorLiteral(vector);

  const [docRows, fileRows, chatRows] = await Promise.all([
    prisma.$queryRaw<{ doc_id: string; chunk: number; content: string; distance: number }[]>(
      Prisma.sql`SELECT doc_id, chunk, content, embedding <=> ${Prisma.raw(vectorLiteral)} AS distance
        FROM ai_user_doc_embeddings WHERE user_id = ${userId}
        ORDER BY distance ASC LIMIT ${topK}`
    ),
    prisma.$queryRaw<{ file_id: string; chunk: number; content: string; distance: number }[]>(
      Prisma.sql`SELECT file_id, chunk, content, embedding <=> ${Prisma.raw(vectorLiteral)} AS distance
        FROM ai_user_file_embeddings WHERE user_id = ${userId}
        ORDER BY distance ASC LIMIT ${topK}`
    ),
    prisma.$queryRaw<{ session_id: string; chunk: number; content: string; distance: number }[]>(
      Prisma.sql`SELECT session_id, chunk, content, embedding <=> ${Prisma.raw(vectorLiteral)} AS distance
        FROM ai_user_chat_embeddings WHERE user_id = ${userId}
        ORDER BY distance ASC LIMIT ${topK}`
    ),
  ]);

  const results: SearchResult[] = [
    ...docRows.map(r => ({ targetId: r.doc_id, targetType: 'doc' as const, chunk: r.chunk, content: r.content, distance: r.distance })),
    ...fileRows.map(r => ({ targetId: r.file_id, targetType: 'file' as const, chunk: r.chunk, content: r.content, distance: r.distance })),
    ...chatRows.map(r => ({ targetId: r.session_id, targetType: 'chat' as const, chunk: r.chunk, content: r.content, distance: r.distance })),
  ];

  return results.sort((a, b) => a.distance - b.distance).slice(0, topK);
}
