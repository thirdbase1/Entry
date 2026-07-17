import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { CONNECT_CONNECTORS, isConnectAuthorized } from '@entry/agent/lib/connect-service-tokens';

/**
 * GET /api/integrations/connect/status
 * For the signed-in user: which of the real Vercel-Connect-backed
 * services (github, vercel, supabase) they've actually completed OAuth
 * for. Live-checked against Connect on every call (a cheap, cached
 * getToken probe) rather than duplicated in our own DB, so this can
 * never drift from the real grant state (e.g. if the user revoked it
 * from the Vercel dashboard directly).
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const services = Object.keys(CONNECT_CONNECTORS);
  const entries = await Promise.all(
    services.map(async service => [service, await isConnectAuthorized(session.user.id, service)] as const)
  );

  return NextResponse.json({ connected: Object.fromEntries(entries) });
});
