/**
 * Replaces `plugins/copilot/workspace/{service,resolver}.ts` +
 * `models/copilot-user.ts`'s doc/file half (the `CopilotUserConfigModel`
 * methods operating on `AiUserDocs`/`AiUserFiles`).
 *
 * IMPORTANT NAMING NOTE (flagged directly to the user in chat): despite the
 * original file living under a folder called `workspace/`, this is NOT
 * Entry's multi-user collaborative workspace (there is no such resolver
 * left in this fork — confirmed by a repo-wide grep, this pivoted product
 * dropped multi-doc collab). What's actually here is the copilot's
 * per-user RAG context store: text "docs" and uploaded "files" a user adds
 * so the agent can search them for grounding. Kept the original DB
 * model/field names (`docId`, `sessionId`, etc.) for continuity.
 *
 * Blob storage: the original's `CopilotStorage` abstraction (S3-shaped) is
 * replaced with **Vercel Blob** (`@vercel/blob`, confirmed real v2.5.0) —
 * the native Vercel-platform equivalent for this target, needs
 * `BLOB_READ_WRITE_TOKEN` (auto-provisioned by Vercel when a Blob store is
 * attached to the project).
 *
 * Embedding pipeline (`copilot.embedding.docs`/`.files` queue jobs ->
 * embedding/service.ts -> `AiUserDocEmbedding`/`AiUserFileEmbedding`
 * pgvector rows -> `searchEmbeddings()`) is now wired: every add/update
 * below enqueues a `jobQueue.add('copilot.embedding.*', ...)` call, mirroring
 * the original service's `queueDocEmbedding`/`queueFileEmbedding` call
 * sites. See embedding/jobs.ts for the consumer side.
 */
import { put, del } from '@vercel/blob';
import { prisma } from '@entry/db';
import { jobQueue } from '@entry/queue';
export { searchEmbeddings, type SearchResult } from './embedding/service';

export interface CopilotUserDoc {
  docId: string;
  sessionId: string;
  title: string;
  content: string;
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CopilotUserFile {
  userId: string;
  fileId: string;
  fileName: string;
  blobId: string;
  mimeType: string;
  size: number;
  metadata: string;
  createdAt: Date;
}

export interface PaginationInput {
  first?: number;
  offset?: number;
}

// ---------------- Docs ----------------

export async function addDoc(
  userId: string,
  sessionId: string,
  options: { title: string; content: string; metadata?: string }
): Promise<CopilotUserDoc> {
  const { title, content, metadata = '' } = options;
  const doc = await prisma.aiUserDocs.create({
    data: { userId, sessionId, title, content, metadata },
  });
  await jobQueue.add('copilot.embedding.docs', { userId, docId: doc.docId }).catch(() => {});
  return doc;
}

export async function getDoc(userId: string, docId: string): Promise<CopilotUserDoc | null> {
  return prisma.aiUserDocs.findFirst({ where: { userId, docId } });
}

export async function updateDoc(
  userId: string,
  docId: string,
  options: { title?: string; content?: string; metadata?: string }
): Promise<CopilotUserDoc> {
  if (!options.title && !options.content) {
    throw new Error('At least one of title or content must be provided for doc update.');
  }
  const doc = await prisma.aiUserDocs.update({
    where: { userId_docId: { userId, docId } },
    data: {
      title: options.title,
      content: options.content,
      metadata: options.metadata ?? '',
      updatedAt: new Date(),
    },
  });
  if (options.content) {
    // only re-embed when content actually changed, mirroring the original's
    // resolver-level call site (title-only edits don't touch embeddings)
    await jobQueue.add('copilot.embedding.docs', { userId, docId }).catch(() => {});
  }
  return doc;
}

export async function removeDoc(userId: string, docId: string): Promise<boolean> {
  const { count } = await prisma.aiUserDocs.deleteMany({ where: { userId, docId } });
  return count > 0;
}

export async function listDocs(
  userId: string,
  pagination?: PaginationInput
): Promise<[CopilotUserDoc[], number]> {
  return Promise.all([
    prisma.aiUserDocs.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: pagination?.offset,
      take: pagination?.first,
    }),
    prisma.aiUserDocs.count({ where: { userId } }),
  ]);
}

// ---------------- Files ----------------

export async function addFile(
  userId: string,
  file: { name: string; type: string; buffer: Buffer },
  metadata = ''
): Promise<{ blobId: string; file: CopilotUserFile }> {
  // Vercel Blob assigns its own random suffix/id; we key rows by that
  // pathname instead of the original's sha256-content-hash blobId, since
  // Blob doesn't expose content-addressing the way the original's storage
  // abstraction did — functionally equivalent (a stable unique pointer to
  // the stored bytes), just Blob's own scheme rather than a hand-computed hash.
  const blob = await put(`copilot/${userId}/${crypto.randomUUID()}-${file.name}`, file.buffer, {
    access: 'public',
    contentType: file.type,
  });

  const row = await prisma.aiUserFiles.create({
    data: {
      userId,
      fileId: crypto.randomUUID(),
      fileName: file.name,
      blobId: blob.url,
      mimeType: file.type,
      size: file.buffer.length,
      metadata,
    },
  });

  await jobQueue
    .add('copilot.embedding.files', {
      userId,
      fileId: row.fileId,
      blobId: blob.url,
      fileName: file.name,
      mimeType: file.type,
    })
    .catch(() => {});

  return { blobId: blob.url, file: row };
}

export async function getFile(
  userId: string,
  options: { fileId?: string; blobId?: string }
): Promise<CopilotUserFile | null> {
  if (!options.fileId && !options.blobId) {
    throw new Error('File ID or Blob ID is required');
  }
  return prisma.aiUserFiles.findFirst({ where: { userId, ...options } });
}

/**
 * Reconstructs a file's full extracted text by concatenating its embedding
 * chunks in order. Files have no single `content` column like docs do
 * (AiUserFiles only stores fileName/mimeType/size/blobId) — the actual
 * extracted text only exists chunked in AiUserFileEmbedding, produced by
 * the indexing job after upload. Returns '' if indexing hasn't finished
 * yet (or produced no embeddings), so callers can fall back gracefully.
 */
export async function getFileContent(userId: string, fileId: string): Promise<string> {
  const chunks = await prisma.aiUserFileEmbedding.findMany({
    where: { userId, fileId },
    orderBy: { chunk: 'asc' },
    select: { content: true },
  });
  return chunks.map(c => c.content).join('\n');
}

export async function updateFile(userId: string, fileId: string, metadata = ''): Promise<CopilotUserFile> {
  return prisma.aiUserFiles.update({
    where: { userId_fileId: { userId, fileId } },
    data: { metadata },
  });
}

export async function removeFile(userId: string, fileId: string): Promise<boolean> {
  const existing = await prisma.aiUserFiles.findFirst({ where: { userId, fileId } });
  if (existing?.blobId) {
    // best-effort — don't fail the delete if the blob is already gone
    await del(existing.blobId).catch(() => {});
  }
  // embeddings cascade-delete via the FK constraint, same as the original
  await prisma.aiUserFiles.deleteMany({ where: { userId, fileId } });
  return true;
}

export async function listFiles(
  userId: string,
  pagination?: PaginationInput
): Promise<[CopilotUserFile[], number]> {
  return Promise.all([
    prisma.aiUserFiles.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: pagination?.offset,
      take: pagination?.first,
    }),
    prisma.aiUserFiles.count({ where: { userId } }),
  ]);
}

export * from './chats';

/**
 * Registers the `copilot.embedding.*` job handlers (see embedding/jobs.ts)
 * as a STATIC (not dynamic) import — this module's top-level import graph
 * is also traced by eve's agent-tool bundler (doc_compose.ts /
 * make_it_real.ts import `addDoc` from here), whose Rolldown-based bundler
 * requires every authored tool to resolve to exactly ONE output chunk. A
 * dynamic `import()` anywhere in the reachable graph forces Rolldown to
 * split off a second chunk regardless of whether the containing function
 * is actually called from the tool's code path, which fails eve's
 * single-chunk bundling with "Expected one bundled authored module" —
 * confirmed via a real Vercel build failure. `embedding/jobs.ts` is
 * side-effect-only (registers handlers on the shared `jobQueue`), so a
 * static import here is equivalent at runtime — this function now just
 * re-exposes that side effect under its original name/call signature so
 * `apps/web/app/api/queues/copilot/route.ts`'s call site needs no changes.
 */
import './embedding/jobs';

export async function registerEmbeddingJobHandlers() {
  // no-op: registration already happened via the static import above.
}

