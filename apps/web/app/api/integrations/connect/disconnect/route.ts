import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { z } from 'zod';
import { hasConnectConnector, disconnectConnectAuthorization } from '@entry/agent/lib/connect-service-tokens';
import { deleteCredential } from '@entry/agent/lib/credential-vault';

const Schema = z.object({ service: z.string().min(1).max(64) });

/**
 * POST /api/integrations/connect/disconnect
 * Revokes the current user's OAuth grant for a Connect-backed service
 * at the source (Vercel calls the provider's revocation endpoint where
 * supported, otherwise marks it dead in Connect's own store).
 *
 * github (2026-07-18): disconnects the direct-OAuth vault credential
 * instead (see github-oauth/start+callback routes for why github no
 * longer goes through Vercel Connect at all).
 */
export const POST = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { service } = Schema.parse(await req.json());
  if (!hasConnectConnector(service)) {
    return NextResponse.json({ error: `"${service}" has no Connect grant to disconnect.` }, { status: 400 });
  }

  if (service === 'github') {
    await deleteCredential(session.user.id, 'github');
    return NextResponse.json({ ok: true });
  }

  await disconnectConnectAuthorization(session.user.id, service);
  return NextResponse.json({ ok: true });
});
