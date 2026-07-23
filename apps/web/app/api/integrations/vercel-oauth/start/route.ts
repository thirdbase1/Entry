import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHash } from 'node:crypto';
import { getUserSessionFromRequest } from '@entry/auth';
import { getPublicOrigin } from '@/lib/public-origin';

/** Only allow redirecting back to a chat session page — never an
 *  arbitrary path, so this can't be abused as an open redirect. */
function sanitizeReturnTo(value: string | null): string | null {
  if (!value) return null;
  return /^\/chats\/[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}

function pkceVerifier(): string {
  return randomBytes(48).toString('base64url');
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * GET /api/integrations/vercel-oauth/start
 *
 * ADDED 2026-07-23: real, standalone "Sign in with Vercel" OAuth 2.0 +
 * PKCE flow (https://vercel.com/docs/sign-in-with-vercel), registered as
 * its own Vercel OAuth application (dashboard: Integrations Console ->
 * your app -> Authentication). This is a completely different product
 * from the old @vercel/connect "Vercel Connect" marketplace SDK this repo
 * used before -- Connect only works when the CALLING app itself runs on
 * Vercel (it authenticates itself to Connect via an OIDC token only
 * Vercel's own runtime can mint); this is a normal, provider-agnostic
 * OAuth authorization-code flow any host (including Render) can do, no
 * different in kind from GitHub's or Google's OAuth.
 *
 * Requires VERCEL_OAUTH_CLIENT_ID / VERCEL_OAUTH_CLIENT_SECRET (from that
 * dashboard) and this exact route's callback URL
 * (`${origin}/api/integrations/vercel-oauth/callback`) registered under
 * "Authorization Callback URLs" in the same dashboard tab.
 *
 * PKCE (S256) is required by Vercel's authorization server, not optional
 * -- code_verifier lives in an httpOnly cookie until the callback.
 */
export async function GET(req: NextRequest) {
  const origin = getPublicOrigin(req);
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.redirect(new URL('/sign-in', origin));

  const clientId = process.env.VERCEL_OAUTH_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'VERCEL_OAUTH_CLIENT_ID is not configured.' }, { status: 500 });
  }

  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(24).toString('base64url');
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get('returnTo'));

  const authorizeUrl = new URL('https://vercel.com/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', `${origin}/api/integrations/vercel-oauth/callback`);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('nonce', nonce);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('response_type', 'code');
  // openid/email/profile for identity, offline_access for a refresh
  // token (access tokens are short-lived) -- the actual Project/
  // Deployment read-write scopes come from whatever's enabled in the
  // dashboard's Permissions tab for this OAuth app, not a query param.
  authorizeUrl.searchParams.set('scope', 'openid email profile offline_access');

  const res = NextResponse.redirect(authorizeUrl.toString());
  const cookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    maxAge: 10 * 60,
    path: '/api/integrations/vercel-oauth',
  };
  res.cookies.set('vercel_oauth_state', state, cookieOpts);
  res.cookies.set('vercel_oauth_nonce', nonce, cookieOpts);
  res.cookies.set('vercel_oauth_verifier', verifier, cookieOpts);
  if (returnTo) res.cookies.set('vercel_oauth_return', returnTo, cookieOpts);
  return res;
}
