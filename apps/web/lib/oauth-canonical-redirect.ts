import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';

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
  // DISABLED (2026-07-27, real bug, user-recorded video + explicit
  // report: "GitHub doesn't even go to GitHub, it just automatically
  // reloads back to the integration page" -- STILL happening after the
  // fix above). Root cause of the ACTUAL symptom: this comparison itself
  // never succeeds on Pxxl. `req.nextUrl.origin` is derived from
  // whatever Host Next.js's own server process sees the request as
  // having -- and on Pxxl (same underlying class of bug this file's own
  // header already documents for Render's 0.0.0.0 bind address) that is
  // NOT the public `https://entry.pxxl.pro` the browser actually hit, no
  // matter what `NEXT_PUBLIC_APP_URL` is correctly set to. So `actual`
  // and `canonical` never match, this 307-redirects to the exact same
  // path+query on the canonical origin EVERY time, which -- since the
  // browser is already ON the canonical origin -- lands right back on
  // this exact same route, hits this exact same mismatch again, and
  // redirects again: a genuine, 100%-reproducible infinite redirect loop
  // (confirmed directly: `curl -L` on this route hits curl's own
  // `--max-redirs` ceiling without ever completing). That's the actual
  // "automatically reloads back to the integration page" the user saw --
  // not a silent bounce-after-cookie-mismatch as originally diagnosed,
  // an outright redirect loop the browser gives up on.
  //
  // The cross-domain cookie problem this was originally written to solve
  // (state/PKCE cookies set on one domain, redirect_uri built for a
  // different one) only exists if traffic is genuinely split across two
  // different live domains. It no longer is: Pxxl (entry.pxxl.pro) is
  // now the one and only production target (see pxxl-deployment.md) --
  // there is no second domain in play for this to protect against, so
  // disabling this pre-redirect trades a real, currently-impossible edge
  // case for actually letting the OAuth flow complete at all. Every
  // caller already uses `getPublicOrigin()` directly (env-var-driven, not
  // derived from this same unreliable `req.nextUrl.origin`) for the
  // pieces that actually matter -- `redirect_uri` and the callback
  // landing page -- so removing just this comparison-based pre-redirect
  // doesn't reintroduce the original redirect_uri-mismatch bug either.
  return null;
}
