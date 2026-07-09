/**
 * Replaces `updateUserFiles`/`removeUserFiles` @Mutation on
 * CopilotUserEmbeddingConfigResolver.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getFile, updateFile, removeFile } from '@entry/copilot';

export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { fileId } = await params;
  const file = await getFile(session.user.id, { fileId });
  if (!file) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(file);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { fileId } = await params;
  const body = await req.json();
  const file = await updateFile(session.user.id, fileId, body?.metadata ?? '');
  return Response.json(file);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { fileId } = await params;
  const removed = await removeFile(session.user.id, fileId);
  return Response.json({ removed });
}
