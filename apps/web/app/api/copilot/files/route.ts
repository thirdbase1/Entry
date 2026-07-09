/**
 * Replaces the `files` @ResolveField + `updateUserFiles` upload path on
 * CopilotUserEmbeddingConfigResolver. Accepts multipart/form-data (the Web
 * standard replacement for the original's GraphQL `Upload` scalar).
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { addFile, listFiles } from '@entry/copilot';

export async function GET(req: Request) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const first = searchParams.get('first') ? Number(searchParams.get('first')) : undefined;
  const offset = searchParams.get('offset') ? Number(searchParams.get('offset')) : undefined;

  const [files, totalCount] = await listFiles(session.user.id, { first, offset });
  return Response.json({ files, totalCount });
}

export async function POST(req: Request) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const form = await req.formData();
  const file = form.get('file');
  const metadata = (form.get('metadata') as string) ?? '';

  if (!(file instanceof File)) {
    return Response.json({ error: 'A "file" field is required' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const { blobId, file: row } = await addFile(
    session.user.id,
    { name: file.name, type: file.type || 'application/octet-stream', buffer },
    metadata
  );

  return Response.json({ blobId, file: row }, { status: 201 });
}
