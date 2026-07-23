import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { CONNECT_CONNECTORS, DIRECT_OAUTH_SERVICES, isConnectAuthorized } from '@entry/agent/lib/connect-service-tokens';
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

  // UPDATED 2026-07-23: 'vercel' is a DIRECT_OAUTH_SERVICES member now
  // (its own vercel-oauth routes, vault-only), not a CONNECT_CONNECTORS
  // entry anymore -- union both sets here so its status still shows up
  // at all (it stopped appearing entirely for one deploy after the
  // Vercel Connect removal, always reading as "not connected" even once
  // the user had actually connected via the vault).
  const services = new Set([...Object.keys(CONNECT_CONNECTORS), ...DIRECT_OAUTH_SERVICES]);
  const entries = await Promise.all(
    [...services].map(async service => {
      if (DIRECT_OAUTH_SERVICES.has(service)) {
        const token = await getCredential(session.user.id, service);
        return [service, Boolean(token)] as const;
      }
      return [service, await isConnectAuthorized(session.user.id, service)] as const;
    })
  );

  return NextResponse.json({ connected: Object.fromEntries(entries) });
});
