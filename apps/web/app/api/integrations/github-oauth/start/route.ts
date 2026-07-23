import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getUserSessionFromRequest } from '@entry/auth';
import { getPublicOrigin } from '@/lib/public-origin';

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
 * FIXED (2026-07-18, real bug, user-reported: "The GitHub install and
 * authorize screen doesn't ever show, it only show authorized which is
 * wrong"). This used to point straight at
 * https://github.com/login/oauth/authorize -- the bare OAuth consent
 * screen. `entry-github` (github.com/apps/entry-github) is a GitHub
 * App, not a classic OAuth App, and for a GitHub App those bare-OAuth
 * and "install on repos" grants are two ENTIRELY SEPARATE things.
 * Authorizing OAuth alone proves who the user is and mints a token, but
 * grants that token access to ZERO repositories on its own -- an actual
 * *installation* (picking specific repos, or "all repositories") is
 * what grants any repo access at all. Sending users only through the
 * bare-authorize half, never the install half, is exactly why every
 * push made with a token from this flow kept 403ing no matter how valid
 * the token itself was: there was never any installation, on any repo,
 * for any of these users, ever.
 *
 * Now points at the App's own installation URL instead
 * (github.com/apps/entry-github/installations/new), which shows
 * GitHub's real "Install & Authorize" screen -- lets the user pick
 * repos (or all of them) AND authorizes in the same step, since
 * entry-github has "Request user authorization (OAuth) during
 * installation" enabled. GitHub's callback for this flow sends BOTH
 * `code` (for the OAuth token exchange, same as before) and
 * `installation_id` -- see callback/route.ts for the installation_id
 * handling this required.
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
  const origin = getPublicOrigin(req);
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.redirect(new URL('/sign-in', origin));

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'GITHUB_OAUTH_CLIENT_ID is not configured.' }, { status: 500 });
  }

  const state = randomBytes(24).toString('base64url');
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get('returnTo'));

  // GitHub App install-and-authorize screen (see file comment above for
  // why this replaced a bare login/oauth/authorize call). GitHub sends
  // the user back to entry-github's configured "Setup URL" /
  // "User authorization callback URL" -- that must be set, in the App's
  // own settings on github.com, to this exact route
  // (`${origin}/api/integrations/github-oauth/callback`) for the
  // `code` + `installation_id` this callback expects to actually arrive.
  const authorizeUrl = new URL('https://github.com/apps/entry-github/installations/new');
  authorizeUrl.searchParams.set('state', state);

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
