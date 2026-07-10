/**
 * Chat session index + resumable-snapshot persistence for the eve-backed
 * chat UI (Phase 3). See the `EveChatSession` model comment in
 * packages/db/prisma/schema.prisma for why this is a new table decoupled
 * from the legacy AiSession/AiPrompt system rather than reusing AiSession:
 * eve owns the actual durable session/turn state on its own server
 * (apps/agent, mounted into apps/web via withEve) — this table only powers
 * the chat list / library sidebar UI and lets a page reload resume a
 * conversation via useEveAgent's `initialEvents`/`initialSession`.
 */
import { prisma } from '@entry/db';
import { jobQueue } from '@entry/queue';

export interface ChatSessionSummary {
  id: string;
  title: string | null;
  collected: boolean;
  docId: string | null;
  /** Non-null => this chat is BYOK-direct (see EveChatSession model comment); powers ChatInterface's eve-vs-direct branch on resume. */
  byokModelId: string | null;
  /** Non-null => this chat is a direct Gateway-model chat (explicit picker choice, bypasses eve). Mutually exclusive with byokModelId. */
  requestedModel: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatSessionSnapshot extends ChatSessionSummary {
  events: unknown;
  cursor: unknown;
}

/** Called once we learn the eve sessionId for a brand-new chat (first send). */
export async function createChatSession(
  userId: string,
  sessionId: string,
  opts: { title?: string; docId?: string } = {}
): Promise<ChatSessionSummary> {
  return prisma.eveChatSession.upsert({
    where: { id: sessionId },
    create: {
      id: sessionId,
      userId,
      title: opts.title ?? null,
      docId: opts.docId ?? null,
    },
    update: {},
    select: { id: true, title: true, collected: true, docId: true, byokModelId: true, requestedModel: true, createdAt: true, updatedAt: true },
  });
}

/** Persist the resumable snapshot — call from useEveAgent's onFinish. */
export async function saveChatSnapshot(
  userId: string,
  sessionId: string,
  data: { events: unknown; cursor: unknown; title?: string }
): Promise<void> {
  await prisma.eveChatSession.update({
    where: { id: sessionId, userId },
    data: {
      events: data.events as any,
      cursor: data.cursor as any,
      ...(data.title ? { title: data.title } : {}),
    },
  });
  // Mirrors the original's queueChatEmbedding call site (context/resolver.ts) —
  // keep the chat's semantic-search index current on every persisted turn.
  // Debounced implicitly: embedAndStore() replaces prior chunks wholesale each
  // run, so back-to-back turns just re-embed the (small, growing) transcript
  // rather than accumulating duplicate/stale chunks.
  await jobQueue.add('copilot.embedding.chats', { userId, sessionId }).catch(() => {});
}

export async function getChatSession(userId: string, sessionId: string): Promise<ChatSessionSnapshot | null> {
  const row = await prisma.eveChatSession.findFirst({
    where: { id: sessionId, userId },
  });
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    collected: row.collected,
    docId: row.docId,
    byokModelId: row.byokModelId,
    requestedModel: row.requestedModel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    events: row.events,
    cursor: row.cursor,
  };
}

export async function listChatSessions(userId: string): Promise<ChatSessionSummary[]> {
  const rows = await prisma.eveChatSession.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, title: true, collected: true, docId: true, byokModelId: true, requestedModel: true, createdAt: true, updatedAt: true },
  });
  return rows;
}

export async function toggleChatCollected(userId: string, sessionId: string): Promise<ChatSessionSummary> {
  const existing = await prisma.eveChatSession.findFirst({ where: { id: sessionId, userId } });
  if (!existing) throw new Error('Chat session not found');
  return prisma.eveChatSession.update({
    where: { id: sessionId, userId },
    data: { collected: !existing.collected },
    select: { id: true, title: true, collected: true, docId: true, byokModelId: true, requestedModel: true, createdAt: true, updatedAt: true },
  });
}

export async function removeChatSession(userId: string, sessionId: string): Promise<boolean> {
  try {
    await prisma.eveChatSession.delete({ where: { id: sessionId, userId } });
    return true;
  } catch {
    return false;
  }
}

// ---------------- Public sharing ----------------

export interface ShareState {
  isPublic: boolean;
  shareToken: string | null;
}

/** Toggle public sharing for a chat. Generates a stable share token on first enable. */
export async function setChatPublic(userId: string, sessionId: string, isPublic: boolean): Promise<ShareState> {
  const existing = await prisma.eveChatSession.findFirst({
    where: { id: sessionId, userId },
    select: { shareToken: true },
  });
  if (!existing) throw new Error('Chat session not found');

  const shareToken = existing.shareToken ?? (isPublic ? crypto.randomUUID() : null);

  const row = await prisma.eveChatSession.update({
    where: { id: sessionId, userId },
    data: { isPublic, ...(shareToken ? { shareToken } : {}) },
    select: { isPublic: true, shareToken: true },
  });
  return row;
}

export interface PublicChatSnapshot {
  title: string | null;
  events: unknown;
  cursor: unknown;
}

/**
 * Unauthenticated read path for a shared chat — looked up by opaque share
 * token, never by the real sessionId/userId. Returns null (not an error)
 * for a missing token OR a token whose chat has since been unshared, so
 * callers can 404 uniformly without leaking which case it was.
 */
export async function getPublicChatSession(shareToken: string): Promise<PublicChatSnapshot | null> {
  const row = await prisma.eveChatSession.findFirst({
    where: { shareToken, isPublic: true },
    select: { title: true, events: true, cursor: true },
  });
  return row ?? null;
}
