import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { CONNECT_CONNECTORS, DIRECT_OAUTH_SERVICES, isConnectAuthorized } from '@entry/agent/lib/connect-service-tokens';
import { getCredential } from '@entry/agent/lib/credential-vault';
import { prisma } from '@entry/db';

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
  // githubInstallationId fetched up front (2026-07-29 fix, see below for
  // why the github entry itself now needs it too).
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { githubInstallationId: true },
  });

  const services = new Set([...Object.keys(CONNECT_CONNECTORS), ...DIRECT_OAUTH_SERVICES]);
  const entries = await Promise.all(
    [...services].map(async service => {
      if (DIRECT_OAUTH_SERVICES.has(service)) {
        const token = await getCredential(session.user.id, service);
        // GITHUB "CONNECTED BUT NO REAL INSTALL" FIX (2026-07-29, owner
        // report: "I don't have the entry GitHub install ... but it
        // shows connected"). This used to report `connected: true` the
        // instant a github vault token existed -- which happens as soon
        // as the bare OAuth leg completes, even when the separate App
        // *installation* (the thing that actually grants repo access)
        // never happened or never got verified. A token with zero repo
        // access showing "Connected" is exactly the misleading state the
        // owner hit. For github specifically, only report connected when
        // BOTH a token exists AND we have a (now verified-before-persist,
        // see the oauth callback route) githubInstallationId on file.
        if (service === 'github') {
          return [service, Boolean(token) && Boolean(dbUser?.githubInstallationId)] as const;
        }
        return [service, Boolean(token)] as const;
      }
      return [service, await isConnectAuthorized(session.user.id, service)] as const;
    })
  );

  return NextResponse.json({
    connected: Object.fromEntries(entries),
    githubInstallationId: dbUser?.githubInstallationId ?? null,
  });
});
