import type { NextRequest } from 'next/server';

/**
 * ADDED 2026-07-23 (real production bug): `req.nextUrl.origin` is derived
 * from the incoming request's Host header as Next.js's own server process
 * sees it -- which on Render came through as the internal bind address
 * (`0.0.0.0:10000`, i.e. exactly `HOSTNAME`/`PORT` the container listens
 * on) instead of the public-facing domain the user's browser actually hit.
 * Confirmed live: a GitHub OAuth callback built its redirect_uri from
 * this and got "The redirect_uri MUST match the registered callback URL
 * for this application" back from GitHub, with the browser literally
 * landing on `https://0.0.0.0:10000/settings?...`.
 *
 * SUPERSEDED (2026-07-27, real bug, owner report: "GitHub/Vercel connect
 * redirect_uri is wrong" -- confirmed live). A single fixed
 * NEXT_PUBLIC_APP_URL is wrong by construction now: this app is genuinely
 * served under TWO live production domains at once (`entry.pxxl.pro` AND
 * the custom domain `entry.oneshotsx.cv`, both pointed at the same Pxxl
 * deployment -- confirmed via `/api/admin/diag-host-headers` and Render's
 * own API showing zero custom domains left on the old `entry-web`
 * service). Whichever one is hardcoded, a user connecting from the OTHER
 * domain gets a redirect_uri for a host they didn't even visit, which
 * GitHub/Vercel correctly reject since it doesn't match either provider's
 * registered callback URL for that flow.
 *
 * Confirmed directly (2026-07-27) that Pxxl's edge, unlike Render's, DOES
 * forward the real public-facing `Host` / `X-Forwarded-Host` header
 * per-domain (only `req.url`/`req.nextUrl.origin` itself is the unreliable
 * internal-container value, same class of bug as Render's 0.0.0.0 bind).
 * So: derive the origin from those headers, restricted to a known-good
 * allowlist of our own production domains (never trust an arbitrary Host
 * header blindly -- that would be spoofable and is exactly the kind of
 * value used to build security-sensitive redirect_uris). Falls back to
 * NEXT_PUBLIC_APP_URL for anything not on the allowlist (e.g. a future
 * domain not added here yet, or a request that reaches us some other
 * way), and to `req.nextUrl.origin` for local dev.
 */
const PRODUCTION_ORIGINS = ['https://entry.pxxl.pro', 'https://entry.oneshotsx.cv'];

export function getPublicOrigin(req: NextRequest): string {
  const host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || '').trim();

  if (host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('0.0.0.0')) {
    return req.nextUrl.origin;
  }

  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
  const candidate = `${proto}://${host}`;
  if (PRODUCTION_ORIGINS.includes(candidate)) return candidate;

  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  return req.nextUrl.origin;
}
