import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { getOwnedContext, saveContextConfig, ArtifactEmbedStatus, type ContextChatOrDoc } from '@/lib/copilot-context';

/**
 * POST /api/copilot/context/[id]/chat
 * Add a chat (session) to context. Ported 1:1 from ContextSession.addChat.
 * Body: { sessionId: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: contextId } = await params;
  const { sessionId } = await req.json();
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  const owned = await getOwnedContext(contextId, session.user.id);
  if (!owned) {
    return NextResponse.json({ error: 'Context not found' }, { status: 404 });
  }

  const { config } = owned;
  const existing = config.chats.find(c => c.id === sessionId);
  if (!existing) {
    const record: ContextChatOrDoc = {
      id: sessionId,
      chunkSize: 0,
      status: ArtifactEmbedStatus.processing,
      error: null,
      createdAt: Date.now(),
    };
    config.chats.push(record);
    await saveContextConfig(contextId, config);
    return NextResponse.json(record, { status: 201 });
  }

  return NextResponse.json(existing, { status: 201 });
}

/**
 * DELETE /api/copilot/context/[id]/chat?sessionId=...
 * Remove a chat from context. Ported 1:1 from ContextSession.removeChat.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: contextId } = await params;
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  const owned = await getOwnedContext(contextId, session.user.id);
  if (!owned) {
    return NextResponse.json({ error: 'Context not found' }, { status: 404 });
  }

  const { config } = owned;
  config.chats = config.chats.filter(c => c.id !== sessionId);
  await saveContextConfig(contextId, config);

  return NextResponse.json({ success: true });
}
