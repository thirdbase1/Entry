/**
 * Semantic search over a user's copilot docs/files (embedding/service.ts's
 * `searchEmbeddings`). Powers the ChatInput context-attachment picker's
 * upgrade from manual browse-only to search-ranked results (see
 * components/chat/chat-context.tsx).
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { searchEmbeddings } from '@entry/copilot';

export async function GET(req: Request) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q');
  if (!q) return Response.json({ error: 'q is required' }, { status: 400 });
  const topK = searchParams.get('topK') ? Number(searchParams.get('topK')) : 5;

  try {
    const results = await searchEmbeddings(session.user.id, q, topK);
    return Response.json({ results });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
