import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { saveCredential } from '@entry/agent/lib/credential-vault';

/**
 * GET /api/integrations/github-oauth/callback
 * See start/route.ts for why this exists (direct GitHub OAuth instead of
 * Vercel Connect for github specifically).
 *
 * Exchanges the code for an access token, stores it in the existing
 * per-user credential vault (service: "github") -- resolveServiceCredential
 * already prefers the vault over Connect, so no other call site needs to
 * change at all for the agent's deploy/push actions to start using this
 * token automatically.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const settingsUrl = (status: 'connected' | 'error', message?: string) => {
    const u = new URL('/settings', origin);
    u.searchParams.set('github', status);
    if (message) u.searchParams.set('github_error', message);
    return u.toString();
  };

  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.redirect(new URL('/sign-in', origin));

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const cookieState = req.cookies.get('github_oauth_state')?.value;

  const clearStateCookie = (res: NextResponse) => {
    res.cookies.set('github_oauth_state', '', { maxAge: 0, path: '/api/integrations/github-oauth' });
    return res;
  };

  if (!code || !state || !cookieState || state !== cookieState) {
    return clearStateCookie(NextResponse.redirect(settingsUrl('error', 'invalid_state')));
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return clearStateCookie(NextResponse.redirect(settingsUrl('error', 'not_configured')));
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${origin}/api/integrations/github-oauth/callback`,
      }),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!tokenRes.ok || !tokenJson.access_token) {
      return clearStateCookie(
        NextResponse.redirect(settingsUrl('error', tokenJson.error_description || tokenJson.error || 'token_exchange_failed'))
      );
    }

    await saveCredential({ userId: session.user.id, service: 'github', value: tokenJson.access_token });

    return clearStateCookie(NextResponse.redirect(settingsUrl('connected')));
  } catch (e) {
    return clearStateCookie(NextResponse.redirect(settingsUrl('error', e instanceof Error ? e.message : 'unknown_error')));
  }
}
