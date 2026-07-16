/**
 * One file's line-by-line diff within one version. ?path=<file path>.
 * Ships plain before/after strings; the actual diff highlighting renders
 * client-side (isomorphic `diff` package) — see getFileDiffContent's
 * comment in packages/db/src/chat-versioning.ts.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';
import { getFileDiffContent } from '@entry/db/chat-versioning';

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string; versionNumber: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId, versionNumber: versionNumberStr } = await params;
  const versionNumber = Number(versionNumberStr);
  if (!Number.isInteger(versionNumber)) return Response.json({ error: 'Invalid version number' }, { status: 400 });

  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  if (!path) return Response.json({ error: 'path query param is required' }, { status: 400 });

  const diff = await getFileDiffContent(sessionId, versionNumber, path);
  if (!diff) return Response.json({ error: 'File not found in this version' }, { status: 404 });

  return Response.json({ path, ...diff });
}
