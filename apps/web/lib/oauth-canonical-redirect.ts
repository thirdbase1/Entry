import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getPublicOrigin } from './public-origin';

/**
 * FIXED (2026-07-27, owner report: "GitHub doesn't even go to GitHub, it
 * just automatically reloads back to the integration page"). Root cause:
 * every OAuth `start` route builds its state/PKCE cookies AND its
 * `redirect_uri` off two DIFFERENT origins. The cookies get set on
 * whatever host the browser is actually on when it hits `/start` (e.g. a
 * user working from `entry.pxxl.pro`), but `redirect_uri` / the final
 * post-connect landing page is always the FIXED `NEXT_PUBLIC_APP_URL`
 * origin (`entry.oneshotsx.cv` -- deliberately fixed since 2026-07-23 to
 * dodge a real Render 0.0.0.0-bind bug, see public-origin.ts). GitHub/
 * Vercel only ever redirect back to that fixed callback origin, which
 * never has the state/PKCE cookies the browser set on the OTHER domain
 * (cookies never cross domains) -- so the callback's state/PKCE check
 * always fails and silently bounces the user straight back to
 * `/settings` with no visible error, looking exactly like "it never even
 * went to GitHub".
 *
 * Fix: if the incoming request's real host differs from the canonical
 * `NEXT_PUBLIC_APP_URL` origin, 307-redirect ONCE to the exact same path
 * + query string on the canonical origin BEFORE anything else runs (no
 * cookies set yet, so nothing to lose) -- every following request in the
 * flow (this route's own re-entry, then the provider's redirect back)
 * happens entirely on the canonical origin, so cookies set there are
 * always readable at the callback. Returns null when already canonical
 * (the normal case) so the caller proceeds as before.
 */
export function redirectToCanonicalOriginIfNeeded(req: NextRequest): NextResponse | null {
  const canonical = getPublicOrigin(req);
  const actual = req.nextUrl.origin;
  if (actual === canonical) return null;
  const target = new URL(req.nextUrl.pathname + req.nextUrl.search, canonical);
  return NextResponse.redirect(target.toString(), 307);
}
