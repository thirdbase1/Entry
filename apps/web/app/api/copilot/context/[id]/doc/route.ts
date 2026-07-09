import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { getOwnedContext, saveContextConfig, ArtifactEmbedStatus, type ContextChatOrDoc } from '@/lib/copilot-context';

/**
 * POST /api/copilot/context/[id]/doc
 * Add a doc to context. Ported 1:1 from ContextSession.addDoc.
 * Body: { docId: string }
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
  const { docId } = await req.json();
  if (!docId) {
    return NextResponse.json({ error: 'docId is required' }, { status: 400 });
  }

  const owned = await getOwnedContext(contextId, session.user.id);
  if (!owned) {
    return NextResponse.json({ error: 'Context not found' }, { status: 404 });
  }

  const { config } = owned;
  const existing = config.docs.find(d => d.id === docId);
  if (!existing) {
    const record: ContextChatOrDoc = {
      id: docId,
      chunkSize: 0,
      status: ArtifactEmbedStatus.processing,
      error: null,
      createdAt: Date.now(),
    };
    config.docs.push(record);
    await saveContextConfig(contextId, config);
    return NextResponse.json(record, { status: 201 });
  }

  return NextResponse.json(existing, { status: 201 });
}

/**
 * DELETE /api/copilot/context/[id]/doc?docId=...
 * Remove a doc from context. Ported 1:1 from ContextSession.removeDoc.
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
  const docId = url.searchParams.get('docId');
  if (!docId) {
    return NextResponse.json({ error: 'docId is required' }, { status: 400 });
  }

  const owned = await getOwnedContext(contextId, session.user.id);
  if (!owned) {
    return NextResponse.json({ error: 'Context not found' }, { status: 404 });
  }

  const { config } = owned;
  config.docs = config.docs.filter(d => d.id !== docId);
  await saveContextConfig(contextId, config);

  return NextResponse.json({ success: true });
}
