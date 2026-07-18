import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getUserSessionFromRequest } from '@entry/auth';

/** Only allow redirecting back to a chat session page — never an
 *  arbitrary path, so this can't be abused as an open redirect. */
function sanitizeReturnTo(value: string | null): string | null {
  if (!value) return null;
  return /^\/chats\/[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}

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
 *
 * `returnTo` (2026-07-18, in-chat connect card): when present, the
 * callback redirects back to that exact chat instead of /settings, so
 * the chat can auto-send "Connected github." and the agent can resume
 * whatever it was doing without the user retyping anything.
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
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get('returnTo'));

  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', 'repo');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('allow_signup', 'false');

  const res = NextResponse.redirect(authorizeUrl.toString());
  res.cookies.set('github_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 10 * 60,
    path: '/api/integrations/github-oauth',
  });
  if (returnTo) {
    res.cookies.set('github_oauth_return', returnTo, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 10 * 60,
      path: '/api/integrations/github-oauth',
    });
  }
  return res;
}
