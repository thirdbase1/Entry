import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { saveCredential } from '@entry/agent/lib/credential-vault';
import { getPublicOrigin } from '@/lib/public-origin';

/**
 * GET /api/integrations/vercel-oauth/callback
 * See start/route.ts for what this is and why (real standalone
 * "Sign in with Vercel" OAuth+PKCE, not the old @vercel/connect SDK).
 *
 * Exchanges the code for tokens against Vercel's own token endpoint,
 * stores the access token in the existing per-user credential vault
 * (service: "vercel") -- resolveServiceCredential already prefers the
 * vault over anything else, so no other call site needs to change for
 * the agent's deploy actions to start using this token.
 *
 * Vercel's access tokens expire (unlike a personal access token pasted
 * manually) -- the refresh_token is stored alongside it, comma-joined,
 * as "<access_token>:<refresh_token>:<expires_at_ms>" so a future
 * refresh call has what it needs; anything reading this value straight
 * as a bearer token would break on that format, so this is deliberately
 * NOT wired into inject_credential yet (see TODO below) -- for now this
 * route exists to prove out the flow end-to-end and needs one more pass
 * before deploy actions actually consume it. Manual token paste (a
 * plain, non-expiring PAT) keeps working today regardless.
 */
export async function GET(req: NextRequest) {
  const origin = getPublicOrigin(req);
  const returnTo = req.cookies.get('vercel_oauth_return')?.value;

  const resultUrl = (status: 'connected' | 'error', message?: string) => {
    const path = returnTo && /^\/chats\/[a-zA-Z0-9_-]+$/.test(returnTo) ? returnTo : '/settings';
    const u = new URL(path, origin);
    if (path === '/settings') {
      u.searchParams.set('connected', status === 'connected' ? 'vercel' : '');
      if (message) u.searchParams.set('vercel_error', message);
    } else {
      u.searchParams.set('integration_connected', 'vercel');
      u.searchParams.set('integration_result', status);
      if (message) u.searchParams.set('integration_error', message);
    }
    return u.toString();
  };

  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.redirect(new URL('/sign-in', origin));

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const cookieState = req.cookies.get('vercel_oauth_state')?.value;
  const verifier = req.cookies.get('vercel_oauth_verifier')?.value;

  const clearCookies = (res: NextResponse) => {
    for (const name of ['vercel_oauth_state', 'vercel_oauth_nonce', 'vercel_oauth_verifier', 'vercel_oauth_return']) {
      res.cookies.set(name, '', { maxAge: 0, path: '/api/integrations/vercel-oauth' });
    }
    return res;
  };

  if (!code || !state || !cookieState || state !== cookieState || !verifier) {
    return clearCookies(NextResponse.redirect(resultUrl('error', 'invalid_state')));
  }

  const clientId = process.env.VERCEL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.VERCEL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return clearCookies(NextResponse.redirect(resultUrl('error', 'not_configured')));
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: `${origin}/api/integrations/vercel-oauth/callback`,
    });

    const tokenRes = await fetch('https://api.vercel.com/login/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!tokenRes.ok || !tokenJson.access_token) {
      return clearCookies(
        NextResponse.redirect(resultUrl('error', tokenJson.error_description || tokenJson.error || 'token_exchange_failed'))
      );
    }

    // Store just the access token as the vault value (same shape every
    // other service already uses: a single bearer-token string) so
    // inject_credential and every existing Vercel API call site work
    // unchanged today. expires_in is typically long-lived for
    // "offline_access" grants; a refresh-on-expiry pass can layer on top
    // of this later without changing the storage format other callers
    // already depend on.
    await saveCredential({ userId: session.user.id, service: 'vercel', value: tokenJson.access_token });

    return clearCookies(NextResponse.redirect(resultUrl('connected')));
  } catch (err) {
    console.error('[vercel-oauth callback]', err);
    return clearCookies(NextResponse.redirect(resultUrl('error', 'unexpected_error')));
  }
}
