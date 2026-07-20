/**
 * Route-auth policy for this agent's built-in `/eve/v1/session*` HTTP API
 * (see eve/docs/guides/auth-and-route-protection.md, read directly from the
 * installed package this session — not assumed).
 *
 * Actual deployment topology: `apps/web/next.config.ts` uses `withEve()` to
 * mount apps/agent's `/eve/v1/*` routes DIRECTLY into the apps/web Next.js
 * origin (same process, same deployment, same request). There is no
 * separate apps/agent Vercel project and no server-to-server proxy hop —
 * the browser's `eve/react` client calls `/eve/v1/session*` directly,
 * same-origin, and sends the user's Better Auth session cookie, not a
 * bearer JWT.
 *
 * That mismatch (this file originally requiring `jwtHmac()` while the real
 * caller is a browser with only a session cookie, and
 * `EVE_INTERNAL_JWT_SECRET` unset in production so even the JWT path was
 * fully disabled) meant every chat turn in production 401'd with
 * "Authorization is required for this route" — confirmed live against
 * https://entry.oneshotsx.cv/chats.
 *
 * Fix, take 2: authenticate the real caller — the logged-in browser's
 * Better Auth session cookie — by calling this same deployment's own
 * `/api/internal/session` route over HTTP, instead of importing any
 * `better-auth` code directly into this file.
 *
 * Why not import Better Auth directly here (take 1, session-only.ts):
 * even a *minimal* `betterAuth({ database, session })` instance still
 * imports `better-auth` core, whose `@better-auth/core` dependency has an
 * optional-instrumentation module doing `await import("@opentelemetry/api")`
 * at module scope. apps/agent's build (`eve build`, Rolldown-based) bundles
 * every authored channel file into exactly one chunk; a dynamic `import()`
 * anywhere in that module graph makes Rolldown split off a second chunk,
 * which fails eve's "expect exactly one bundled chunk" invariant with
 * `Failed to bundle authored module ".../eve.ts"` / `Expected one bundled
 * authored module.` — confirmed live via `vercel build` locally (the only
 * place a real build completes; see DEPLOY.md for why Vercel's *remote*
 * build container can't be used to diagnose this at all — it dies earlier
 * with an unrelated platform bug before ever reaching the agent build
 * step). Installing `@opentelemetry/api` as a real dependency fixed the
 * *unresolved import* half of the problem but not this chunk-count one,
 * since the import is dynamic either way.
 *
 * apps/web already imports the full `@entry/auth` package elsewhere (e.g.
 * `app/api/chats/route.ts`), so none of this is new bundle weight *there*
 * — `/api/internal/session` just exposes the existing
 * `getUserSessionFromRequest()` check over HTTP so this file can call it
 * with the forwarded cookie header instead of re-bundling Better Auth
 * (and its dynamic otel import) into the agent's single-chunk build.
 *
 * `jwtHmac()` is kept as a second entry in case a genuine future
 * server-to-server caller is added; `localDev()` stays last for `eve dev`
 * / manual curl testing.
 */
import { eveChannel } from 'eve/channels/eve';
import { type AuthFn, jwtHmac, localDev } from 'eve/channels/auth';

interface InternalSessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Authenticates the actual first-party caller: a logged-in browser hitting
 * `/eve/v1/session*` same-origin with its Better Auth session cookie.
 * Verifies it by calling this same deployment's own
 * `/api/internal/session` route (same process, same origin — a loopback
 * HTTP call, not a separate service) and forwarding the Cookie header.
 * Returns null (not a throw) on no/invalid session or any network hiccup,
 * so the walk falls through to the other auth entries instead of hard-
 * failing here.
 */
/**
 * Short-TTL auth cache (2026-07-19, real "takes time to connect to the
 * model" latency fix): the loopback `/api/internal/session` verification
 * below is a FULL extra HTTP round trip through the platform's front door
 * (same deployment, but still a real network hop on Vercel -- not an
 * in-process call), and it ran on EVERY single `/eve/v1/*` request: every
 * send, every stream open, and every one of the client's automatic
 * reconnect attempts (up to 20 per turn -- see chat-interface.tsx's
 * maxReconnectAttempts). That put a whole serial HTTP round trip in front
 * of every turn before eve even started the model call. A 60s in-memory
 * cache keyed by the exact Cookie header removes it from every request
 * after the first: Better Auth session cookies are stable strings for the
 * life of the session (rotation issues a NEW cookie value = new cache
 * key), and 60s is far shorter than any session expiry, so the worst case
 * is honoring a just-revoked session for under a minute on an
 * already-warm instance -- the same window a CDN-cached session check
 * would have. Entries are pruned lazily on lookup so the map can't grow
 * unboundedly on a long-lived instance.
 */
interface CachedPrincipal {
  value: Awaited<ReturnType<ReturnType<typeof betterAuthSession>>>;
  expiresAt: number;
}
const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new Map<string, CachedPrincipal>();

function betterAuthSession(): AuthFn<Request> {
  return async (request) => {
    const cookie = request.headers.get('cookie');
    if (!cookie) return null;

    const now = Date.now();
    const cached = authCache.get(cookie);
    if (cached && cached.expiresAt > now) return cached.value;
    if (authCache.size > 500) {
      for (const [k, v] of authCache) if (v.expiresAt <= now) authCache.delete(k);
    }

    let user: InternalSessionUser | null;
    try {
      const origin = new URL(request.url).origin;
      const res = await fetch(`${origin}/api/internal/session`, {
        headers: { cookie },
        // Same-process loopback call — keep this fast and never let a
        // slow/hanging internal fetch block the whole chat request.
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { user: InternalSessionUser | null };
      user = body.user;
    } catch {
      return null;
    }
    if (!user) return null;

    const principal = {
      attributes: {
        email: user.email,
        name: user.name,
      },
      authenticator: 'better-auth',
      principalId: user.id,
      principalType: 'user' as const,
    };
    authCache.set(cookie, { value: principal, expiresAt: now + AUTH_CACHE_TTL_MS });
    return principal;
  };
}

const secret = process.env.EVE_INTERNAL_JWT_SECRET;

/**
 * CORS -- Pxxl migration (PXXL_MIGRATION.md). Only actually matters once
 * this agent is deployed standalone (Pxxl) and the browser calls it
 * cross-origin instead of same-origin via `withEve()`; harmless no-op
 * shape for the still-live in-process Vercel mount (same-origin calls
 * never trigger CORS regardless). Narrowed to the real production origin
 * (plus whatever ENTRY_WEB_ORIGIN is set to, e.g. a preview URL) rather
 * than `cors: true`'s permissive any-origin default.
 */
const webOrigin = process.env.ENTRY_WEB_ORIGIN ?? 'https://entry.oneshotsx.cv';

export default eveChannel({
  cors: {
    origin: webOrigin,
    methods: ['GET', 'POST'],
    allowedHeaders: ['authorization', 'content-type'],
  },
  auth: [
    betterAuthSession(),
    ...(secret
      ? [
          jwtHmac({
            algorithm: 'HS256' as const,
            issuer: 'entry-web',
            audiences: ['entry-agent'],
            secret,
          }),
        ]
      : []),
    localDev(),
  ],
});
