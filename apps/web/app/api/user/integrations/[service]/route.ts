import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { deleteCredential } from '@entry/agent/lib/credential-vault';

/**
 * DELETE /api/user/integrations/:service?label=default
 * Disconnects one saved token. Same vault as chat-side credentials, so
 * disconnecting here also stops the AI's inject_credential from finding
 * a value for this service/label.
 */
export const DELETE = withApiErrorHandling(async (req: NextRequest, { params }: { params: Promise<{ service: string }> }) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { service } = await params;
  const label = req.nextUrl.searchParams.get('label') ?? 'default';
  await deleteCredential(session.user.id, decodeURIComponent(service), label);
  return NextResponse.json({ ok: true });
});
