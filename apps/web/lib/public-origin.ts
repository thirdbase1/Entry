import type { NextRequest } from 'next/server';

/**
 * ADDED 2026-07-23 (real production bug): `req.nextUrl.origin` is derived
 * from the incoming request's Host header as Next.js's own server process
 * sees it -- which on Render came through as the internal bind address
 * (`0.0.0.0:10000`, i.e. exactly `HOSTNAME`/`PORT` the container listens
 * on) instead of the public-facing `https://entry.oneshotsx.cv` the user's
 * browser actually hit. Confirmed live: a GitHub OAuth callback built its
 * redirect_uri from this and got
 *   "The redirect_uri MUST match the registered callback URL for this
 *   application" back from GitHub, with the browser literally landing on
 *   `https://0.0.0.0:10000/settings?...`.
 *
 * This was never a problem on Vercel (their edge network always presents
 * the real public Host to the app). Any OAuth flow's redirect_uri is
 * *exactly* the class of value that must be byte-for-byte correct (it's
 * checked against the provider's registered callback URL), so it can't
 * be left depending on how a given host's proxy happens to forward
 * headers -- use one fixed, known-correct source of truth instead.
 *
 * Set NEXT_PUBLIC_APP_URL to the real canonical production origin
 * (`https://entry.oneshotsx.cv`, no trailing slash) and every redirect_uri
 * builder should call this instead of touching `req.nextUrl.origin`
 * directly. Falls back to `req.nextUrl.origin` only when the env var is
 * unset, so local dev (`http://localhost:3000`) keeps working with zero
 * extra setup.
 */
export function getPublicOrigin(req: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return req.nextUrl.origin;
}
