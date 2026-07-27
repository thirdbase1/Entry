import { NextRequest, NextResponse } from 'next/server';
import { getUserSessionFromRequest } from '@entry/auth';
import { getPublicOrigin } from '@/lib/public-origin';
import { saveCredential } from '@entry/agent/lib/credential-vault';
import { prisma } from '@entry/db';

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
 *
 * 2026-07-18: redirects back to the originating chat (via the
 * `github_oauth_return` cookie set in start/route.ts) when present, with
 * `?integration_connected=github&integration_result=connected|error` --
 * chat-interface.tsx auto-sends "Connected github."/an error message from
 * that, so the agent resumes the task with no retyping needed. Falls back
 * to the old /settings redirect when there's no return chat (e.g. someone
 * connecting straight from the Settings page).
 *
 * 2026-07-18: start/route.ts now sends users through entry-github's real
 * install-and-authorize screen (github.com/apps/entry-github/installations/new)
 * instead of a bare OAuth authorize -- see that file's comment for the
 * real bug this fixes (users were authorizing but never installing on
 * any repo, so every push kept 403ing with a valid-looking token and
 * zero actual repo access). GitHub's redirect back from that screen adds
 * `installation_id` alongside the usual `code` -- persisted here into
 * `User.githubInstallationId` (the exact column connect-service-tokens.ts
 * already reads/writes for the Vercel-Connect path, kept in sync here
 * too) so any code that checks "does this user have a real installation"
 * sees the truth regardless of which of the two flows the user went
 * through.
 */
export async function GET(req: NextRequest) {
  const origin = getPublicOrigin(req);
  const returnTo = req.cookies.get('github_oauth_return')?.value;

  const resultUrl = (status: 'connected' | 'error', message?: string) => {
    const path = returnTo && /^\/chats\/[a-zA-Z0-9_-]+$/.test(returnTo) ? returnTo : '/settings';
    const u = new URL(path, origin);
    if (path === '/settings') {
      // LANDED-ON-WRONG-TAB FIX (2026-07-27, owner report: "how come I
      // click connect, it's taking me to the byok page" -- Settings'
      // page.tsx defaults to the 'providers' (BYOK) tab whenever no
      // `?tab=` param is present at all, and this redirect never set one
      // -- so a successful connect silently dumped the user back onto
      // BYOK instead of the Integrations tab they just came from, making
      // it look like the click did nothing / went to the wrong place).
      u.searchParams.set('tab', 'integrations');
      u.searchParams.set('connected', status === 'connected' ? 'github' : '');
      if (message) u.searchParams.set('github_error', message);
    } else {
      u.searchParams.set('integration_connected', 'github');
      u.searchParams.set('integration_result', status);
      if (message) u.searchParams.set('integration_error', message);
    }
    return u.toString();
  };

  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.redirect(new URL('/sign-in', origin));

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const installationId = req.nextUrl.searchParams.get('installation_id');
  const setupAction = req.nextUrl.searchParams.get('setup_action');
  const cookieState = req.cookies.get('github_oauth_state')?.value;

  const clearCookies = (res: NextResponse) => {
    res.cookies.set('github_oauth_state', '', { maxAge: 0, path: '/api/integrations/github-oauth' });
    res.cookies.set('github_oauth_return', '', { maxAge: 0, path: '/api/integrations/github-oauth' });
    return res;
  };
  const clearCookiesAndRedirect = (url: string) => clearCookies(NextResponse.redirect(url));

  // SURFACE REAL ERRORS (2026-07-27): GitHub's own authorize endpoint
  // redirects straight back here with `error`/`error_description` on
  // things like access_denied or a redirect_uri it doesn't recognize --
  // previously these fell through to the generic "invalid_state" bucket
  // below (code/state genuinely are absent on this path too), hiding the
  // real reason from both the user and anyone debugging it later.
  const providerError = req.nextUrl.searchParams.get('error');
  const providerErrorDescription = req.nextUrl.searchParams.get('error_description');
  if (providerError) {
    return clearCookiesAndRedirect(resultUrl('error', providerErrorDescription || providerError));
  }

  // "UPDATE INSTALLATION" REDIRECT FIX (2026-07-27, owner report: "when
  // I updated it didn't redirect back"). GitHub sends a user straight to
  // this callback (via the App's Setup URL) when they revisit an
  // EXISTING installation from github.com itself to add/remove repos --
  // that visit never went through our /start route at all, so there is
  // no `github_oauth_state` cookie, no `code`, and no `state` param; it's
  // just `installation_id` + `setup_action=update`. The old code treated
  // any missing code/state as a hard "invalid_state" error and bounced
  // the user to a dead end, even though nothing was actually wrong --
  // no NEW OAuth grant is needed here (the user already has a valid
  // token in the vault from their original connect), only the
  // (possibly changed) installation_id needs persisting. Handle this as
  // its own case, before the OAuth-state check, and only fall through to
  // requiring a real code+state when this ISN'T a plain update visit.
  if (setupAction === 'update' && installationId && !code) {
    if (session) {
      await prisma.user
        .update({ where: { id: session.user.id }, data: { githubInstallationId: installationId } })
        .catch(err => console.error('[github-oauth callback] failed to persist installationId on update', session.user.id, err));
    }
    return clearCookies(NextResponse.redirect(resultUrl('connected')));
  }

  if (!code || !state || !cookieState || state !== cookieState) {
    return clearCookies(NextResponse.redirect(resultUrl('error', 'invalid_state')));
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return clearCookies(NextResponse.redirect(resultUrl('error', 'not_configured')));
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
      return clearCookies(
        NextResponse.redirect(resultUrl('error', tokenJson.error_description || tokenJson.error || 'token_exchange_failed'))
      );
    }

    await saveCredential({ userId: session.user.id, service: 'github', value: tokenJson.access_token });

    // Persist the installation the user just picked repos for (or
    // "updated" -- setup_action=update -- if they revisited an existing
    // one to add/remove repos). Best-effort: a user who somehow lands
    // here without an installation_id (shouldn't happen via the
    // installations/new URL, but keep this robust to a stray direct hit
    // on this callback) still gets their OAuth token saved above --
    // just without repo access until they do install it.
    if (installationId) {
      await prisma.user
        .update({ where: { id: session.user.id }, data: { githubInstallationId: installationId } })
        .catch(err => console.error('[github-oauth callback] failed to persist installationId', session.user.id, setupAction, err));
    }

    return clearCookies(NextResponse.redirect(resultUrl('connected')));
  } catch (e) {
    return clearCookies(NextResponse.redirect(resultUrl('error', e instanceof Error ? e.message : 'unknown_error')));
  }
}
