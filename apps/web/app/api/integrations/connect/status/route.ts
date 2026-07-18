import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { CONNECT_CONNECTORS, isConnectAuthorized } from '@entry/agent/lib/connect-service-tokens';
import { getCredential } from '@entry/agent/lib/credential-vault';

/**
 * GET /api/integrations/connect/status
 * For the signed-in user: which of the one-click-connect services
 * (github, vercel, supabase) they've actually completed auth for.
 *
 * github (2026-07-18): checked against our own credential vault now, not
 * Vercel Connect -- see github-oauth/start+callback routes for why.
 * vercel/supabase: still live-checked against Connect on every call (a
 * cheap, cached getToken probe) rather than duplicated in our own DB, so
 * this can never drift from the real grant state.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const services = Object.keys(CONNECT_CONNECTORS);
  const entries = await Promise.all(
    services.map(async service => {
      if (service === 'github') {
        const token = await getCredential(session.user.id, 'github');
        return [service, Boolean(token)] as const;
      }
      return [service, await isConnectAuthorized(session.user.id, service)] as const;
    })
  );

  return NextResponse.json({ connected: Object.fromEntries(entries) });
});
