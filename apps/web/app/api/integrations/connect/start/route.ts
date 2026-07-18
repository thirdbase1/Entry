import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { z } from 'zod';
import { hasConnectConnector, startConnectAuthorization } from '@entry/agent/lib/connect-service-tokens';

const Schema = z.object({
  service: z.string().min(1).max(64),
  /** In-chat connect card (2026-07-18): when present and it's a real
   *  chat path, Vercel redirects back to that exact chat (with
   *  ?integration_connected=<service>) instead of /settings, so the chat
   *  can auto-send "Connected <service>." and the agent resumes. */
  returnTo: z.string().optional(),
});

function sanitizeReturnTo(value: string | undefined): string | null {
  if (!value) return null;
  return /^\/chats\/[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}

/**
 * POST /api/integrations/connect/start
 * Begins the real per-user OAuth flow for a Connect-backed service
 * (vercel, supabase). Returns a `url` for the browser to navigate to;
 * Vercel handles the entire provider consent + token exchange
 * server-side and redirects back to `callbackUrl` when done — nothing
 * for this app to do on return, the next status/getToken call for this
 * user just starts succeeding.
 */
export const POST = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { service, returnTo } = Schema.parse(await req.json());
  if (!hasConnectConnector(service)) {
    return NextResponse.json({ error: `"${service}" doesn't support one-click connect — use the manual token field instead.` }, { status: 400 });
  }

  const origin = req.nextUrl.origin;
  const safeReturnTo = sanitizeReturnTo(returnTo);
  const callbackUrl = safeReturnTo
    ? `${origin}${safeReturnTo}?integration_connected=${encodeURIComponent(service)}&integration_result=connected`
    : `${origin}/settings?connected=${encodeURIComponent(service)}`;

  const url = await startConnectAuthorization(session.user.id, service, callbackUrl);
  return NextResponse.json({ url });
});
