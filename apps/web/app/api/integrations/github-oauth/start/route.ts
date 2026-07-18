import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getUserSessionFromRequest } from '@entry/auth';

/**
 * GET /api/integrations/github-oauth/start
 *
 * 2026-07-18: Direct GitHub OAuth, bypassing Vercel Connect's github
 * connector entirely. Connect's github flow never actually completed a
 * per-user grant no matter how many times the install was redone (see
 * connect-service-tokens.ts's file header + git history for the full
 * saga) -- this uses GitHub's own standard OAuth authorize/token
 * exchange instead, with a real redirect-back callback on our own
 * domain (no popup/poll hack needed).
 *
 * Full top-level navigation (not fetch+JSON) so a plain <a href> or
 * window.location.href works from the client.
 */
export async function GET(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.redirect(new URL('/sign-in', req.url));

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'GITHUB_OAUTH_CLIENT_ID is not configured.' }, { status: 500 });
  }

  const state = randomBytes(24).toString('base64url');
  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/integrations/github-oauth/callback`;

  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', 'repo');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('allow_signup', 'false');

  const res = NextResponse.redirect(authorizeUrl.toString());
  // Short-lived, httpOnly CSRF-state cookie -- checked against the `state`
  // query param on callback. Not tied to userId (session cookie already
  // carries that); this only guards against a forged callback request.
  res.cookies.set('github_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 10 * 60,
    path: '/api/integrations/github-oauth',
  });
  return res;
}
