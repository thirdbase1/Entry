import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { getOwnedContext, saveContextConfig, fulfillFile, ArtifactEmbedStatus, type ContextFile } from '@/lib/copilot-context';
import { randomUUID } from 'node:crypto';

/**
 * POST /api/copilot/context/[id]/file
 * Add a file to context. Ported 1:1 from ContextSession.addFile — dedupes by
 * blobId (same blob content reuses the same file id) rather than always
 * minting a new attachment.
 * Body: { blobId: string, name: string, mimeType: string }
 *
 * The original accepted a file upload (GraphQLUpload). In the REST API, the
 * client first uploads the file to storage, then passes the blobId + metadata.
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
  const { blobId, name, mimeType } = await req.json();

  if (!blobId || !name || !mimeType) {
    return NextResponse.json({
      error: 'blobId, name, and mimeType are required',
    }, { status: 400 });
  }

  const owned = await getOwnedContext(contextId, session.user.id);
  if (!owned) {
    return NextResponse.json({ error: 'Context not found' }, { status: 404 });
  }

  const { config } = owned;
  const existingBlob = config.files.find(f => f.blobId === blobId);
  if (existingBlob) {
    if (existingBlob.status === ArtifactEmbedStatus.finished) {
      return NextResponse.json(fulfillFile(existingBlob), { status: 201 });
    }
    return NextResponse.json(fulfillFile(existingBlob), { status: 201 });
  }

  const record: ContextFile = {
    id: randomUUID(),
    blobId,
    name,
    mimeType,
    chunkSize: 0,
    status: ArtifactEmbedStatus.processing,
    error: null,
    createdAt: Date.now(),
  };
  config.files.push(record);
  await saveContextConfig(contextId, config);

  return NextResponse.json(fulfillFile(record), { status: 201 });
}

/**
 * DELETE /api/copilot/context/[id]/file?fileId=...
 * Remove a file from context. Ported 1:1 from ContextSession.removeFile.
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
  const fileId = url.searchParams.get('fileId');
  if (!fileId) {
    return NextResponse.json({ error: 'fileId is required' }, { status: 400 });
  }

  const owned = await getOwnedContext(contextId, session.user.id);
  if (!owned) {
    return NextResponse.json({ error: 'Context not found' }, { status: 404 });
  }

  const { config } = owned;
  config.files = config.files.filter(f => f.id !== fileId);
  await saveContextConfig(contextId, config);

  return NextResponse.json({ success: true });
}
