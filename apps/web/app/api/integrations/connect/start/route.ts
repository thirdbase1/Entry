import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { z } from 'zod';
import { hasConnectConnector, startConnectAuthorization } from '@entry/agent/lib/connect-service-tokens';

const Schema = z.object({ service: z.string().min(1).max(64) });

/**
 * POST /api/integrations/connect/start
 * Begins the real per-user OAuth flow for a Connect-backed service
 * (github, vercel, supabase). Returns a `url` for the browser to
 * navigate to; Vercel handles the entire provider consent + token
 * exchange server-side and redirects back to `callbackUrl` (this app's
 * own Settings page) when done — nothing for this app to do on return,
 * the next status/getToken call for this user just starts succeeding.
 */
export const POST = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { service } = Schema.parse(await req.json());
  if (!hasConnectConnector(service)) {
    return NextResponse.json({ error: `"${service}" doesn't support one-click connect — use the manual token field instead.` }, { status: 400 });
  }

  const origin = req.nextUrl.origin;
  const url = await startConnectAuthorization(session.user.id, service, `${origin}/settings?connected=${encodeURIComponent(service)}`);
  return NextResponse.json({ url });
});
