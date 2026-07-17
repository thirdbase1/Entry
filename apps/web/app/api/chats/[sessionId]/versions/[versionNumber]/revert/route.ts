/**
 * One-click revert — the ONLY action a version's history page exposes
 * (no "Compare", per the user's explicit spec: a version already IS one
 * snapshot). Computes what changed via `planRevert` (pure/read-only),
 * applies it to the chat's real live sandbox, records the result as a
 * new, honest, forward-only ChatVersion (never rewrites history), and
 * appends the "Version N · Reverted from vM" chat card via the same
 * `flushPendingVersion` -> `appendVersionCardMessage` path every normal
 * agent turn uses.
 *
 * Scoped to direct/BYOK chats only for now, same split as the versions
 * list route's `canRevertLive` and the existing Files tab — eve-default
 * chats don't have an equally direct sandbox-by-chatId accessor wired up
 * yet outside of a live tool call (confirmed: eve's own sandbox session
 * state is opaque, no external by-chatId reconnect exists today).
 *
 * GET added (2026-07-17, "improve versioning/revert/history x4" push,
 * real gap: reverting to an OLD version showed only THAT version's own
 * historical file count — e.g. "Version #5 · 3 files changed" — which
 * describes what changed AT #5, not what actually happens if you revert
 * to it from today's head #40. If 60 files drifted since, the confirm
 * dialog gave zero warning of that. This computes the REAL revert scope
 * via the same `planRevert` the POST uses, pure read-only (never
 * touches the sandbox), so the UI can show "this will update N files
 * and remove M" before the user ever commits to it.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';
import { planRevert, flushPendingVersion, recordFileChange } from '@entry/db/chat-versioning';
import { getSandboxForChat } from '@/lib/direct-chat/sandbox';

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string; versionNumber: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId, versionNumber: versionNumberStr } = await params;
  const targetVersion = Number(versionNumberStr);
  if (!Number.isInteger(targetVersion)) return Response.json({ error: 'Invalid version number' }, { status: 400 });

  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const actions = await planRevert(sessionId, targetVersion);
  const willWrite = actions.filter(a => a.action === 'write').length;
  const willDelete = actions.filter(a => a.action === 'delete').length;

  return Response.json({
    totalChanges: actions.length,
    willWrite,
    willDelete,
    noop: actions.length === 0,
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string; versionNumber: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId, versionNumber: versionNumberStr } = await params;
  const targetVersion = Number(versionNumberStr);
  if (!Number.isInteger(targetVersion)) return Response.json({ error: 'Invalid version number' }, { status: 400 });

  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!chat.byokModelId && !chat.requestedModel) {
    return Response.json({ error: 'Revert is only available for BYOK / direct-model chats right now.' }, { status: 400 });
  }

  const actions = await planRevert(sessionId, targetVersion);
  if (actions.length === 0) {
    return Response.json({ error: 'Already at this version — nothing to revert.' }, { status: 400 });
  }

  const sandbox = await getSandboxForChat(sessionId);

  for (const action of actions) {
    const safePath = JSON.stringify(action.path);
    if (action.action === 'delete') {
      await sandbox.run({ command: `rm -f ${safePath}` });
      recordFileChange(sessionId, action.path, 'deleted', null);
    } else {
      const b64 = Buffer.from(action.content ?? '', 'utf8').toString('base64');
      const cmd = `mkdir -p "$(dirname ${safePath})" && printf '%s' '${b64}' | base64 -d > ${safePath}`;
      const result = await sandbox.run({ command: cmd });
      if (result.exitCode !== 0) {
        return Response.json({ error: `Failed to restore ${action.path}: ${result.stderr.slice(0, 300)}` }, { status: 500 });
      }
      recordFileChange(sessionId, action.path, 'modified', action.content);
    }
  }

  const result = await flushPendingVersion(sessionId, { revertedFromVersionNumber: targetVersion });
  if (!result) {
    return Response.json({ error: 'Revert produced no changes to record.' }, { status: 500 });
  }

  return Response.json({
    versionNumber: result.versionNumber,
    summary: result.summary,
    filesChanged: result.filesChanged,
    linesAdded: result.linesAdded,
    linesRemoved: result.linesRemoved,
    revertedFromVersionNumber: targetVersion,
  });
}
