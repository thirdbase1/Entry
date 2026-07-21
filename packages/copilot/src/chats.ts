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
import { Prisma } from '@entry/db';
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
  /** True while a durable Trigger.dev worker run is continuing this chat's
   *  turn in the background -- see EveChatSession model comment. */
  backgroundRunActive: boolean;
  /** Trigger.dev run ID of the active background worker, when
   *  backgroundRunActive is true -- lets the frontend mint a scoped
   *  realtime token to subscribe to that run's live chunk stream. */
  backgroundRunId: string | null;
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
    select: { id: true, title: true, collected: true, docId: true, byokModelId: true, requestedModel: true, createdAt: true, updatedAt: true, backgroundRunActive: true, backgroundRunId: true },
  });
}

/**
 * Persist the resumable snapshot — call from useEveAgent's onFinish.
 *
 * FIXED (2026-07-18, real data-loss bug reported: "sometimes if I reload a
 * chat I won't see the AI response messages at all, it wipes and never
 * shows in the chat again"): this is called from TWO independent writers
 * for the same row -- the original tab's own `onFinish` (the COMPLETE,
 * correct final event list once a turn genuinely finishes) AND
 * eve-reconcile.ts's `reconcileEveSession`, triggered server-side by a
 * page reload landing mid-turn, which re-streams the live eve session for
 * only up to 8 seconds and persists whatever partial slice of events it
 * captured in that window. A plain `.update()` here is unconditional
 * last-write-wins with no ordering guarantee between those two callers --
 * if the reconciler's (shorter, partial) write happened to land in
 * Postgres AFTER the tab's own (complete) write, the shorter snapshot
 * silently became the row's new permanent truth. Since the underlying eve
 * session itself later expires (confirmed in reconcileEveSession's own
 * comment), nothing could ever recover the lost tail of that conversation
 * after that point -- exactly the reported "wipes and never shows again."
 *
 * Fix: a single atomic conditional UPDATE that only writes when the
 * incoming event count is >= what's already persisted for this row --
 * i.e. this can never shrink the stored transcript, no matter which of
 * the two callers' writes happens to land last. A no-op WHERE-guard
 * miss here is silent and safe (the row already holds the longer,
 * correct version); nothing more needs to happen in that case.
 */
export async function saveChatSnapshot(
  userId: string,
  sessionId: string,
  data: { events?: unknown; cursor?: unknown; title?: string }
): Promise<void> {
  // No `events` at all (e.g. a hypothetical future title-only rename call) --
  // nothing for the anti-shrink guard below to protect, and matches the
  // original plain `.update()`'s semantics of leaving untouched fields alone.
  if (data.events === undefined) {
    await prisma.eveChatSession.update({
      where: { id: sessionId, userId },
      data: {
        ...(data.cursor !== undefined ? { cursor: data.cursor as any } : {}),
        ...(data.title ? { title: data.title } : {}),
      },
    });
    return;
  }
  const incomingLength = Array.isArray(data.events) ? data.events.length : 0;
  const eventsJson = JSON.stringify(data.events ?? []);
  const cursorJson = JSON.stringify(data.cursor ?? null);
  const titleFragment = data.title ? Prisma.sql`, title = ${data.title}` : Prisma.empty;
  await prisma.$executeRaw`
    UPDATE eve_chat_sessions
    SET events = ${eventsJson}::jsonb,
        cursor = ${cursorJson}::jsonb,
        updated_at = now()
        ${titleFragment}
    WHERE id = ${sessionId}
      AND user_id = ${userId}
      AND (events IS NULL OR jsonb_array_length(events) <= ${incomingLength})
  `;
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
    backgroundRunActive: row.backgroundRunActive,
    backgroundRunId: row.backgroundRunId,
    events: row.events,
    cursor: row.cursor,
  };
}

/**
 * Flip the background-handoff flag -- called by the sync direct-chat route
 * the instant it hands a turn off to the durable Trigger.dev worker
 * (true), and by the orchestrator task's own try/finally once that worker
 * run genuinely finishes, one way or another (false). Deliberately no
 * userId filter: both callers are trusted server-side code (the route
 * already validated the user earlier in the same request; the Trigger.dev
 * task runs with the payload's own already-authenticated userId), and
 * gating on userId here would just be one more way this could silently
 * no-op if a future caller ever got the id slightly wrong.
 */
export async function setBackgroundRunActive(sessionId: string, active: boolean): Promise<void> {
  await prisma.eveChatSession.update({
    where: { id: sessionId },
    data: { backgroundRunActive: active },
  }).catch(() => {});
}

/**
 * Persist the Trigger.dev run ID for the currently-active background
 * worker run, right after `.trigger()` resolves in route.ts's handoff --
 * this is what /api/chats/[sessionId]/realtime-token reads to know which
 * run to mint a scoped public access token for. Cleared (set to null)
 * whenever setBackgroundRunActive(sessionId, false) fires, so a stale run
 * ID from a previous turn can never be handed out once that run is done.
 */
export async function setBackgroundRunId(sessionId: string, runId: string | null): Promise<void> {
  await prisma.eveChatSession.update({
    where: { id: sessionId },
    data: { backgroundRunId: runId },
  }).catch(() => {});
}

export async function listChatSessions(userId: string): Promise<ChatSessionSummary[]> {
  const rows = await prisma.eveChatSession.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, title: true, collected: true, docId: true, byokModelId: true, requestedModel: true, createdAt: true, updatedAt: true, backgroundRunActive: true, backgroundRunId: true },
  });
  return rows;
}

export async function toggleChatCollected(userId: string, sessionId: string): Promise<ChatSessionSummary> {
  const existing = await prisma.eveChatSession.findFirst({ where: { id: sessionId, userId } });
  if (!existing) throw new Error('Chat session not found');
  return prisma.eveChatSession.update({
    where: { id: sessionId, userId },
    data: { collected: !existing.collected },
    select: { id: true, title: true, collected: true, docId: true, byokModelId: true, requestedModel: true, createdAt: true, updatedAt: true, backgroundRunActive: true, backgroundRunId: true },
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
