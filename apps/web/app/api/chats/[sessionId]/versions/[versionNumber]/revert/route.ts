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
 * yet outside of a live tool call.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';
import { planRevert, flushPendingVersion, recordFileChange } from '@entry/db/chat-versioning';
import { getSandboxForChat } from '@/lib/direct-chat/sandbox';

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
