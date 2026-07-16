/**
 * Per-chat version history (2026-07-16). See ChatVersion/ChatVersionFile's
 * schema comments for the full "why" -- short version: the user explicitly
 * rejected both a git/GitHub-based history and a raw Vercel-deployment
 * history, and asked for "our own internal versioning system": every time
 * the agent modifies >=1 file, snapshot it; show a minimal card ("Version
 * #24 · Just now · 12 files changed · +184 -57"); tapping it opens a
 * per-file line-by-line diff; the only action is an instant, one-click
 * Revert (no Compare button -- a version already IS a single snapshot).
 *
 * Hook point: `recordFileChange()` is called from the single choke point
 * every file mutation already goes through regardless of which chat path
 * is driving it (sandboxWriteFile/sandboxAppendFile in
 * apps/agent/agent/lib/tool-impls/sandbox-file-io.ts, shared by both eve's
 * root agent and the direct/BYOK chat path -- see that file). Each call
 * buffers the change in-memory for that chatId; the actual ChatVersion +
 * ChatVersionFile rows are only written once by `flushPendingVersion()`,
 * called via Next's `after()` once the whole turn's HTTP response has
 * fully finished (so one version = one whole agent turn, not one per
 * individual tool call, matching "when the agent finishes a task").
 */
import * as Diff from 'diff';
import { prisma } from './db.js';

type ChangeType = 'added' | 'modified' | 'deleted';

interface PendingChange {
  path: string;
  changeType: ChangeType;
  content: string | null; // null for a delete
}

// In-memory per-chat buffer. Safe within a single serverless invocation's
// lifetime (one Node process handles one turn's full tool-calling loop
// start to finish) -- see file comment. Keyed by chatId so concurrent
// turns on different chats in the same warm process never collide.
const pendingByChat = new Map<string, Map<string, PendingChange>>();

/** Called from sandbox-file-io.ts right after a write/append/delete
 *  actually succeeds against the sandbox. Last write for a given path
 *  within one turn wins (Map keyed by path) -- a version reflects the NET
 *  change over the whole turn, not every intermediate edit. */
export function recordFileChange(chatId: string, path: string, changeType: ChangeType, content: string | null): void {
  let bucket = pendingByChat.get(chatId);
  if (!bucket) {
    bucket = new Map();
    pendingByChat.set(chatId, bucket);
  }
  bucket.set(path, { path, changeType, content });
}

/** True the FIRST time a file changes within the current turn's buffer
 *  for this chat -- used by the caller to know whether it still needs to
 *  register an `after()` flush for this turn (only needs to happen once). */
export function isFirstPendingChangeForChat(chatId: string): boolean {
  const bucket = pendingByChat.get(chatId);
  return !bucket || bucket.size === 0;
}

function diffStats(before: string | null, after: string | null): { linesAdded: number; linesRemoved: number } {
  if (before == null && after == null) return { linesAdded: 0, linesRemoved: 0 };
  if (before == null) return { linesAdded: (after ?? '').split('\n').length, linesRemoved: 0 };
  if (after == null) return { linesAdded: 0, linesRemoved: before.split('\n').length };
  const parts = Diff.diffLines(before, after);
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const lineCount = part.value.endsWith('\n') ? part.value.split('\n').length - 1 : part.value.split('\n').length;
    if (part.added) added += lineCount;
    else if (part.removed) removed += lineCount;
  }
  return { linesAdded: added, linesRemoved: removed };
}

function summarize(changes: PendingChange[]): string {
  const added = changes.filter(c => c.changeType === 'added');
  const modified = changes.filter(c => c.changeType === 'modified');
  const deleted = changes.filter(c => c.changeType === 'deleted');
  const basename = (p: string) => p.split('/').pop() || p;

  if (changes.length <= 4) {
    const parts: string[] = [];
    if (added.length) parts.push(`Added ${added.map(c => basename(c.path)).join(', ')}`);
    if (modified.length) parts.push(`Updated ${modified.map(c => basename(c.path)).join(', ')}`);
    if (deleted.length) parts.push(`Deleted ${deleted.map(c => basename(c.path)).join(', ')}`);
    return parts.join(' · ');
  }

  const parts: string[] = [];
  if (added.length) parts.push(`${added.length} added`);
  if (modified.length) parts.push(`${modified.length} updated`);
  if (deleted.length) parts.push(`${deleted.length} deleted`);
  return `${changes.length} files changed (${parts.join(', ')})`;
}

/** Finds what this path's content was immediately before the current
 *  turn, i.e. the `content` of the highest versionNumber < the new one
 *  being created for this chatId+path. Null if never tracked before (a
 *  genuinely new file) or if its last tracked state was itself 'deleted'. */
async function findPreviousContent(chatId: string, path: string): Promise<string | null> {
  const prior = await prisma.chatVersionFile.findFirst({
    where: { chatId, path },
    orderBy: { versionNumber: 'desc' },
  });
  if (!prior || prior.changeType === 'deleted') return null;
  return prior.content;
}

/**
 * Writes the buffered changes for one chat as a single new ChatVersion,
 * if there are any. Safe to call multiple times (e.g. a defensive extra
 * `after()` registration) -- it's a no-op once the buffer for that chat
 * is empty. Returns the created version's summary info, or null if there
 * was nothing to record.
 */
export async function flushPendingVersion(
  chatId: string,
  opts: { revertedFromVersionNumber?: number; summaryOverride?: string } = {},
): Promise<{ versionNumber: number; summary: string; filesChanged: number; linesAdded: number; linesRemoved: number } | null> {
  const bucket = pendingByChat.get(chatId);
  if (!bucket || bucket.size === 0) return null;
  const changes = Array.from(bucket.values());
  pendingByChat.delete(chatId);

  let totalAdded = 0;
  let totalRemoved = 0;
  const fileRows: Array<{ path: string; changeType: ChangeType; content: string | null; linesAdded: number; linesRemoved: number }> = [];

  for (const change of changes) {
    const before = await findPreviousContent(chatId, change.path);
    const { linesAdded, linesRemoved } = diffStats(before, change.content);
    totalAdded += linesAdded;
    totalRemoved += linesRemoved;
    fileRows.push({ path: change.path, changeType: change.changeType, content: change.content, linesAdded, linesRemoved });
  }

  const summary = opts.summaryOverride ?? summarize(changes);

  const result = await prisma.$transaction(async tx => {
    const last = await tx.chatVersion.findFirst({ where: { chatId }, orderBy: { versionNumber: 'desc' } });
    const versionNumber = (last?.versionNumber ?? 0) + 1;

    const version = await tx.chatVersion.create({
      data: {
        chatId,
        versionNumber,
        summary,
        filesChanged: fileRows.length,
        linesAdded: totalAdded,
        linesRemoved: totalRemoved,
        revertedFromVersionNumber: opts.revertedFromVersionNumber ?? null,
      },
    });

    await tx.chatVersionFile.createMany({
      data: fileRows.map(f => ({
        chatId,
        versionId: version.id,
        versionNumber,
        path: f.path,
        changeType: f.changeType,
        content: f.content,
        linesAdded: f.linesAdded,
        linesRemoved: f.linesRemoved,
      })),
    });

    return version;
  });

  const info = { versionNumber: result.versionNumber, summary, filesChanged: fileRows.length, linesAdded: totalAdded, linesRemoved: totalRemoved, revertedFromVersionNumber: opts.revertedFromVersionNumber };
  await appendVersionCardMessage(chatId, info);
  return info;
}

/**
 * Returns the before/after full content for one path within one version
 * -- "before" is whatever that path last held in an earlier version (or
 * null if this is its first appearance); "after" is null if this
 * version's change was a delete. The actual line-by-line diff rendering
 * happens client-side (same `diff` package, isomorphic) so the server
 * only ever ships two plain strings, not a pre-rendered diff blob.
 */
/**
 * Appends a lightweight, self-contained "version card" message to a
 * direct/BYOK chat's persisted `events` (a real AI SDK UIMessage[] for
 * that chat shape -- see EveChatSession.events' schema comment). Renders
 * client-side via the `data-version-card` part type
 * (components/chat/renderers/version-card.tsx). Deliberately a no-op for
 * eve-default-path chats: their `events` holds eve's own
 * HandleMessageStreamEvent[] log, a completely different shape that this
 * app's eve event-reducer/replay owns end to end -- splicing a raw
 * UIMessage into that array would corrupt it. Matches the same
 * eve-vs-direct split already established for revert (`canRevertLive` in
 * the versions list route) and the Files tab.
 *
 * Best-effort by design (same philosophy as touchChatFileTree /
 * scheduleVersionFlush elsewhere in this feature): the version itself is
 * already durably recorded in ChatVersion/ChatVersionFile by the time
 * this runs, so a failure here just means the chat-visible card doesn't
 * show up immediately -- the version is still fully there in the History
 * page / diff API, never silently lost.
 */
async function appendVersionCardMessage(
  chatId: string,
  info: { versionNumber: number; summary: string; filesChanged: number; linesAdded: number; linesRemoved: number; revertedFromVersionNumber?: number },
): Promise<void> {
  try {
    const chat = await prisma.eveChatSession.findUnique({ where: { id: chatId } });
    if (!chat || (!chat.byokModelId && !chat.requestedModel)) return; // eve-default path -- skip, see comment above

    const events = Array.isArray(chat.events) ? (chat.events as unknown[]) : [];
    const cardMessage = {
      id: `version-card-${info.versionNumber}`,
      role: 'assistant',
      parts: [
        {
          type: 'data-version-card',
          data: {
            versionNumber: info.versionNumber,
            summary: info.summary,
            filesChanged: info.filesChanged,
            linesAdded: info.linesAdded,
            linesRemoved: info.linesRemoved,
            revertedFromVersionNumber: info.revertedFromVersionNumber ?? null,
            createdAt: new Date().toISOString(),
          },
        },
      ],
    };
    await prisma.eveChatSession.update({
      where: { id: chatId },
      data: { events: [...events, cardMessage] as any },
    });
  } catch (err) {
    console.error('[chat-versioning] appendVersionCardMessage failed', chatId, err);
  }
}

export async function getFileDiffContent(
  chatId: string,
  versionNumber: number,
  path: string,
): Promise<{ changeType: ChangeType; before: string | null; after: string | null } | null> {
  const file = await prisma.chatVersionFile.findFirst({ where: { chatId, versionNumber, path } });
  if (!file) return null;
  const before = await prisma.chatVersionFile.findFirst({
    where: { chatId, path, versionNumber: { lt: versionNumber } },
    orderBy: { versionNumber: 'desc' },
  });
  return {
    changeType: file.changeType as ChangeType,
    before: before && before.changeType !== 'deleted' ? before.content : null,
    after: file.content,
  };
}

export interface RevertFileAction {
  path: string;
  action: 'write' | 'delete';
  content: string | null;
}

/**
 * Computes what needs to happen to the LIVE sandbox to make it match
 * `targetVersionNumber`'s state exactly -- both files that need their
 * content restored, and files that need to be deleted because they
 * didn't exist yet as of that version (created by a later one).
 * Pure/read-only: does not touch the sandbox or write any DB rows itself
 * -- the caller applies the actions to the real sandbox, then calls
 * `flushPendingVersion` (after recording each applied change) to log the
 * revert as a new, honest, forward-only version.
 */
export async function planRevert(chatId: string, targetVersionNumber: number): Promise<RevertFileAction[]> {
  const currentHead = await prisma.chatVersion.findFirst({ where: { chatId }, orderBy: { versionNumber: 'desc' } });
  if (!currentHead) return [];

  // Latest known state of every tracked path AS OF the target version.
  const asOfTarget = await prisma.$queryRaw<Array<{ path: string; change_type: string; content: string | null }>>`
    SELECT DISTINCT ON (path) path, change_type, content
    FROM chat_version_files
    WHERE chat_id = ${chatId} AND version_number <= ${targetVersionNumber}
    ORDER BY path, version_number DESC
  `;

  // Latest known state of every tracked path AS OF the current head (now).
  const asOfHead = await prisma.$queryRaw<Array<{ path: string; change_type: string }>>`
    SELECT DISTINCT ON (path) path, change_type
    FROM chat_version_files
    WHERE chat_id = ${chatId} AND version_number <= ${currentHead.versionNumber}
    ORDER BY path, version_number DESC
  `;

  const targetByPath = new Map(asOfTarget.map(r => [r.path, r]));
  const headPaths = new Set(asOfHead.filter(r => r.change_type !== 'deleted').map(r => r.path));

  const actions: RevertFileAction[] = [];

  for (const row of asOfTarget) {
    if (row.change_type === 'deleted') {
      if (headPaths.has(row.path)) actions.push({ path: row.path, action: 'delete', content: null });
    } else {
      actions.push({ path: row.path, action: 'write', content: row.content });
    }
  }

  // Files that exist now but didn't exist yet as of the target version
  // (created by some version AFTER the target) -- must be removed.
  for (const path of headPaths) {
    if (!targetByPath.has(path)) actions.push({ path, action: 'delete', content: null });
  }

  return actions;
}
