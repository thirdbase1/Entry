/**
 * Job handlers for the `copilot.embedding.*` jobs, dispatched off the
 * "copilot" queue topic (see @entry/queue's `namespaceOf` — jobs
 * named `copilot.*` route there).
 *
 * Import this module (side-effect only, via `registerEmbeddingJobHandlers()`
 * in index.ts) from the "copilot" queue's consumer Route Handler so
 * registration happens in the same process that handles the callback.
 */
import { registerJobHandler } from '@entry/queue';
import { prisma } from '@entry/db';
import { embedDoc, embedFile, embedChat } from './service';

registerJobHandler<{ userId: string; docId: string }>('copilot.embedding.docs', async ({ userId, docId }) => {
  const doc = await prisma.aiUserDocs.findFirst({ where: { userId, docId } });
  if (!doc) return; // doc may have been deleted before the job ran
  await embedDoc(userId, docId, doc.content);
});

registerJobHandler<{ userId: string; fileId: string; blobId: string; fileName: string; mimeType: string }>(
  'copilot.embedding.files',
  async ({ userId, fileId, blobId, fileName, mimeType }) => {
    const res = await fetch(blobId); // Vercel Blob URLs are directly fetchable
    if (!res.ok) return;
    const buffer = Buffer.from(await res.arrayBuffer());
    await embedFile(userId, fileId, fileName, mimeType, buffer);
  }
);

registerJobHandler<{ userId: string; sessionId: string }>('copilot.embedding.chats', async ({ userId, sessionId }) => {
  // No eve API round-trip needed — `EveChatSession.events` is already a
  // persisted snapshot (chats.ts's saveChatSnapshot, called every turn).
  await embedChat(userId, sessionId);
});
