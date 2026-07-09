/**
 * Replaces `updateUserDocs`/`removeUserDocs` @Mutation on
 * CopilotUserEmbeddingConfigResolver, plus an added GET (the original had
 * no single-doc GraphQL field — docs were only ever listed via the
 * paginated `docs` field or embedded implicitly via chat context; a direct
 * GET is a reasonable REST addition for a client that already has a docId).
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getDoc, updateDoc, removeDoc } from '@entry/copilot';

export async function GET(req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { docId } = await params;
  const doc = await getDoc(session.user.id, docId);
  if (!doc) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(doc);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { docId } = await params;
  const body = await req.json();
  const { title, content, metadata } = body ?? {};
  if (!title && !content) {
    return Response.json({ error: 'At least one field must be provided for doc update.' }, { status: 400 });
  }

  try {
    const doc = await updateDoc(session.user.id, docId, { title, content, metadata });
    return Response.json(doc);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ docId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { docId } = await params;
  const removed = await removeDoc(session.user.id, docId);
  return Response.json({ removed });
}
