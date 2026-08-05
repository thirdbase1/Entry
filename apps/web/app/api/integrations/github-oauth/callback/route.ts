import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getUserSessionFromRequest } from '@entry/auth';
import { getPublicOrigin } from '@/lib/public-origin';
import { saveCredential } from '@entry/agent/lib/credential-vault';
import { prisma } from '@entry/db';
import { logError } from '@entry/db/error-log';

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

  const resultUrl = (status: 'connected' | 'error', message?: string, pathOverride?: string) => {
    const path = pathOverride ?? (returnTo && /^\/chats\/[a-zA-Z0-9_-]+$/.test(returnTo) ? returnTo : '/settings');
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

  // Extract params early — the update flow needs them before the session
  // check (GitHub's Setup URL redirect has no OAuth state, just
  // installation_id + setup_action).
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const installationId = req.nextUrl.searchParams.get('installation_id');
  const setupAction = req.nextUrl.searchParams.get('setup_action');
  const cookieState = req.cookies.get('github_oauth_state')?.value;

  const clearCookies = (res: NextResponse) => {
    res.headers.set('Cache-Control', 'no-store, must-revalidate');
    res.cookies.set('github_oauth_state', '', { maxAge: 0, path: '/api/integrations/github-oauth' });
    res.cookies.set('github_oauth_return', '', { maxAge: 0, path: '/api/integrations/github-oauth' });
    res.cookies.set('github_pending_installation_id', '', { maxAge: 0, path: '/api/integrations/github-oauth' });
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
  // just `installation_id` + `setup_action=update`.
  //
  // IMPORTANT (2026-07-27 fix #2): This check MUST run before the session
  // check below. The user's session cookie may have expired while they
  // were on github.com managing repos — bouncing them to /sign-in
  // instead of back to Settings looks exactly like "it didn't
  // redirect." We persist the installation_id only if a session exists
  // (best-effort — the installation_id rarely changes during an update
  // anyway), but ALWAYS redirect to the result URL so the user lands
  // back on the app, not stranded on github.com.
  //
  // NOTE: This flow requires the GitHub App's Setup URL to be set to
  //   https://entry.pxxl.run/api/integrations/github-oauth/callback
  // AND "Redirect on update" enabled in the App's settings on
  // github.com/apps/entry-github. Without both, GitHub does NOT
  // redirect here at all after an update — it just leaves the user on
  // the installation configure page.
  if (setupAction === 'update' && installationId && !code) {
    // Session may not be available yet — fetch it here since we moved
    // this check before the main session guard.
    const { session: updateSession } = await getUserSessionFromRequest(req);
    if (updateSession) {
      await prisma.user
        .update({ where: { id: updateSession.user.id }, data: { githubInstallationId: installationId } })
        .catch(err => console.error('[github-oauth callback] failed to persist installationId on update', updateSession.user.id, err));
    }
    // Redirect to /chats?github_picker=1 so the repo picker modal
    // auto-reopens — the user just updated their repo access and should
    // land right back in the picker to select a newly-added repo.
    const pickerUrl = new URL('/chats', origin);
    pickerUrl.searchParams.set('github_picker', '1');
    pickerUrl.searchParams.set('integration_status', 'connected');
    return clearCookies(NextResponse.redirect(pickerUrl.toString()));
  }

  // Session is required for the OAuth code-exchange flow (not for the
  // update flow above, which already returned).
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.redirect(new URL('/sign-in', origin));

  // INSTALL-WITHOUT-OAUTH-CODE FIX (2026-07-28, real bug, confirmed via
  // the diagnostic logging below on the owner's own first-ever install:
  // hasState/hasCookieState/stateMatches ALL true, hasCode FALSE --
  // state was never actually invalid. GitHub's real installations/new
  // screen returned `installation_id` + `state` with NO `code` at all --
  // installing an App and completing its OAuth grant are two genuinely
  // separate GitHub-side steps, and evidently entry-github's install
  // screen only completes the first one in this one round trip. The old
  // code required `code` unconditionally and mislabeled this as
  // "invalid_state", which is exactly backwards -- the install itself
  // had already succeeded (GitHub doesn't hand back a real
  // installation_id otherwise) and the user was shown a scary error for
  // something that actually worked.
  //
  // Fix: when state genuinely matches and we have a real installationId
  // but no code, persist the installation immediately (never block a
  // real success on the separate OAuth half) and chain straight into the
  // bare `login/oauth/authorize` screen to pick up a real user token too
  // -- entry-github supports standalone user-to-server OAuth with the
  // same client id/secret, so this completes transparently (near-instant
  // approval, since the user just installed the app) without needing any
  // change to the GitHub App's own settings.
  if (installationId && !code && state && cookieState && state === cookieState) {
    // VERIFY-BEFORE-TRUST FIX (2026-07-29, real bug, owner report: "I
    // don't have the entry GitHub install, but clicking connect just
    // reloads and shows connected"). The previous version of this branch
    // persisted `installationId` straight from the query string and
    // reported success later purely because the SECOND (chained) leg's
    // code exchange succeeded -- neither step ever actually asked GitHub
    // "is this installation real for this user." Never trust a query
    // param alone for something this consequential. Now: stash the
    // CANDIDATE id in a short-lived cookie instead of the DB, chain into
    // oauth/authorize to get a real token, and only persist + report
    // "connected" once that token is used to confirm the installation
    // truly appears in this user's own `GET /user/installations` below.
    const chainClientId = process.env.GITHUB_OAUTH_CLIENT_ID;
    if (chainClientId) {
      const newState = randomBytes(24).toString('base64url');
      const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
      authorizeUrl.searchParams.set('client_id', chainClientId);
      authorizeUrl.searchParams.set('state', newState);
      authorizeUrl.searchParams.set('redirect_uri', `${origin}/api/integrations/github-oauth/callback`);
      const res = NextResponse.redirect(authorizeUrl.toString());
      res.headers.set('Cache-Control', 'no-store, must-revalidate');
      // Overwrite with a fresh state for this second leg -- leave
      // github_oauth_return untouched so the chained authorize's own
      // callback still knows where to send the user back afterward.
      res.cookies.set('github_oauth_state', newState, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 10 * 60,
        path: '/api/integrations/github-oauth',
      });
      res.cookies.set('github_pending_installation_id', installationId, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 10 * 60,
        path: '/api/integrations/github-oauth',
      });
      return res;
    }
    // No client id configured to chain into OAuth with -- can't get a
    // token to verify against, so don't claim success on an unverified id.
    return clearCookiesAndRedirect(resultUrl('error', 'not_configured'));
  }

  if (!code || !state || !cookieState || state !== cookieState) {
    // DIAGNOSTIC (2026-07-27, real bug, ongoing owner report: still
    // getting "invalid_state" after the stale-installationId fix). This
    // was previously a silent redirect with zero durable trace of WHICH
    // piece was actually missing/mismatched -- logging booleans only
    // (never the actual state/cookie values, those are still
    // security-sensitive) so the next occurrence is diagnosable from
    // error_logs instead of guessed at blind.
    logError({
      source: 'github-oauth-invalid-state',
      error: new Error('GitHub OAuth callback invalid_state'),
      userId: session.user.id,
      context: {
        host: req.headers.get('x-forwarded-host') || req.headers.get('host'),
        hasCode: !!code,
        hasState: !!state,
        hasCookieState: !!cookieState,
        stateMatches: !!state && !!cookieState && state === cookieState,
        referer: req.headers.get('referer'),
      },
    });
    return clearCookiesAndRedirect(resultUrl('error', 'invalid_state'));
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

    // VERIFY-BEFORE-TRUST (2026-07-29, see the no-code branch above for
    // the full bug this closes): the id we're about to persist can come
    // from THIS request's own installation_id query param, or -- on the
    // chained second leg after a no-code install -- from the pending
    // cookie stashed there. Either way, before we ever write it to the
    // DB or tell the user "connected", actually ask GitHub's own
    // `/user/installations` (with the token we JUST obtained) whether it
    // really is installed for this account. A candidate id that doesn't
    // show up there is never persisted and never reported as success --
    // this is the one thing standing between "GitHub told us so" and
    // "we assumed so."
    const pendingInstallationId = req.cookies.get('github_pending_installation_id')?.value ?? null;
    const candidateInstallationId = installationId ?? pendingInstallationId;

    if (candidateInstallationId) {
      let verified = false;
      try {
        const instRes = await fetch('https://api.github.com/user/installations', {
          headers: { Authorization: `Bearer ${tokenJson.access_token}`, Accept: 'application/vnd.github+json' },
        });
        if (instRes.ok) {
          const instJson = (await instRes.json()) as { installations?: Array<{ id: number }> };
          verified = (instJson.installations ?? []).some(i => String(i.id) === String(candidateInstallationId));
        }
      } catch (err) {
        console.error('[github-oauth callback] installation verification call failed', session.user.id, err);
      }

      if (!verified) {
        logError({
          source: 'github-oauth-unverified-installation',
          error: new Error('GitHub did not confirm the installation id before it would have been persisted'),
          userId: session.user.id,
          context: { candidateInstallationId, fromPendingCookie: !candidateInstallationId ? false : installationId == null },
        });
        // A real OAuth token WAS obtained (already saved above), so the
        // user isn't left with nothing -- just don't claim repo access
        // that GitHub itself won't confirm. Tell them plainly instead of
        // silently showing "Connected".
        return clearCookies(
          NextResponse.redirect(resultUrl('error', 'GitHub did not confirm the app installation — click Connect again and complete the Install step on GitHub.'))
        );
      }

      await prisma.user
        .update({ where: { id: session.user.id }, data: { githubInstallationId: candidateInstallationId } })
        .catch(err => console.error('[github-oauth callback] failed to persist installationId', session.user.id, setupAction, err));
    }

    return clearCookies(NextResponse.redirect(resultUrl('connected')));
  } catch (e) {
    return clearCookies(NextResponse.redirect(resultUrl('error', e instanceof Error ? e.message : 'unknown_error')));
  }
}
