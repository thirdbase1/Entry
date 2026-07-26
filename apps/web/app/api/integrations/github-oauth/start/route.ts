import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getUserSessionFromRequest } from '@entry/auth';
import { getPublicOrigin } from '@/lib/public-origin';
import { prisma } from '@entry/db';

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

  // RECONNECT BUG FIX (2026-07-27, owner report: "if someone already
  // has our GitHub app installed on their GitHub but disconnected on our
  // Integrations page ... clicking connect will not redirect the user
  // back"). Root cause is a real GitHub Apps quirk, not our code: hitting
  // `/apps/:slug/installations/new` for an account that ALREADY has the
  // app installed does not show the install screen at all -- GitHub just
  // drops the user straight onto the installation's "Configure" page on
  // github.com itself, with no `code`/`state`, so our callback route
  // never fires and the user is stranded with no way back to us. This
  // only ever happens for accounts with an existing installation, i.e.
  // exactly "disconnected but previously installed" users (disconnect
  // only clears our vault credential -- it never clears
  // `User.githubInstallationId`, since the GitHub-side installation
  // itself isn't touched by our disconnect at all -- see
  // connect/disconnect/route.ts).
  //
  // Fix: if we already know this user has an installation on file, skip
  // `/installations/new` entirely and send them through the plain
  // `login/oauth/authorize` screen instead -- entry-github supports
  // standalone user-to-server OAuth (same client id/secret) precisely
  // because "Request user authorization (OAuth) during installation" is
  // enabled, and that endpoint ALWAYS completes with a real `code` +
  // `state` back to our callback regardless of install state. It won't
  // send a fresh `installation_id`, but the callback only overwrites
  // `githubInstallationId` when one is actually present, so the existing
  // value is left untouched (and remains valid, since the underlying
  // GitHub-side installation was never removed). Only genuinely
  // first-time users (no installationId on file) go through the real
  // install-and-authorize screen, where the "new install" case works
  // exactly as before.
  const existingUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { githubInstallationId: true },
  });

  const authorizeUrl = existingUser?.githubInstallationId
    ? new URL('https://github.com/login/oauth/authorize')
    : new URL('https://github.com/apps/entry-github/installations/new');
  if (existingUser?.githubInstallationId) {
    authorizeUrl.searchParams.set('client_id', clientId);
  }
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
