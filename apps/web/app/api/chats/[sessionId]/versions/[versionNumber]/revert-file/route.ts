/**
 * Single-file revert (2026-07-17, "improve history and versioning" push
 * -- real gap: the only revert action was the WHOLE version's snapshot,
 * so rolling back one bad file change also threw away every other
 * file's progress from that version and any version since, all the way
 * back to the target). This restores exactly one path to its content as
 * of `versionNumber`, leaving every other file untouched. Same
 * mechanics as ./revert/route.ts otherwise: applies to the live
 * sandbox, then records the result as a new, honest, forward-only
 * ChatVersion via the same flushPendingVersion path (so it shows up in
 * history as its own entry, not a silent edit).
 *
 * Scoped to direct/BYOK chats only, same reason as the full revert.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';
import { planRevertSingleFile, flushPendingVersion, recordFileChange } from '@entry/db/chat-versioning';
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

  let body: { path?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const path = body.path;
  if (typeof path !== 'string' || !path || path.includes('..')) {
    return Response.json({ error: 'Invalid path' }, { status: 400 });
  }

  const action = await planRevertSingleFile(sessionId, targetVersion, path);
  if (!action) {
    return Response.json({ error: 'This file already matches that version — nothing to revert.' }, { status: 400 });
  }

  const sandbox = await getSandboxForChat(sessionId);
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

  const result = await flushPendingVersion(sessionId, {
    revertedFromVersionNumber: targetVersion,
    summaryOverride: `Restored ${path.split('/').pop()} from Version #${targetVersion}`,
  });
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
