/**
 * Replaces the `docs` @ResolveField + `addUserDocs` @Mutation on
 * `CopilotUserEmbeddingConfigResolver` (plugins/copilot/workspace/resolver.ts).
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { addDoc, listDocs } from '@entry/copilot';

export async function GET(req: Request) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const first = searchParams.get('first') ? Number(searchParams.get('first')) : undefined;
  const offset = searchParams.get('offset') ? Number(searchParams.get('offset')) : undefined;

  const [docs, totalCount] = await listDocs(session.user.id, { first, offset });
  return Response.json({ docs, totalCount });
}

export async function POST(req: Request) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { sessionId, title, content, metadata } = body ?? {};
  if (!sessionId || !title || !content) {
    return Response.json({ error: 'sessionId, title and content are required' }, { status: 400 });
  }

  const doc = await addDoc(session.user.id, sessionId, { title, content, metadata });
  return Response.json(doc, { status: 201 });
}
