/**
 * Public, unauthenticated read for a shared chat — looked up by opaque
 * share token only (never sessionId/userId). See EveChatSession's
 * isPublic/shareToken schema comment for why this exists: the original's
 * `/playback` route was genuinely public with no auth, but had no
 * persisted "may anyone view this" bit to gate it safely — this closes
 * that real gap rather than leaving it unbuilt.
 */
import { getPublicChatSession } from '@entry/copilot';

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const chat = await getPublicChatSession(token);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(chat);
}
