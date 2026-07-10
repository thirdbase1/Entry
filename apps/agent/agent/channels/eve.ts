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
 * https://entry.oneshotsx.cv/chats: `useEveAgent`'s onError fired
 * `ClientError: Authorization is required for this route.` on every send.
 *
 * Fix: authenticate the real caller — the logged-in browser's Better Auth
 * session cookie — via `getSessionOnly()` from `@entry/auth/src/session-only`.
 *
 * IMPORTANT: this deliberately does NOT import `getUserSessionFromRequest`
 * from the package's main `@entry/auth` entry. That entry transitively
 * loads ./auth.ts, which wires emailAndPassword/emailOTP/social-provider
 * callbacks that all call `sendMail()` from `@entry/mail` at module scope —
 * dragging @entry/mail's full React-Email template tree into this bundle.
 * That extra weight was enough to OOM-kill the Vercel build machine (2
 * cores / 8 GB) with zero error output when this file previously imported
 * the main entry — confirmed live: the production deploy log went straight
 * from "✓ Compiled successfully" to a bare `Command "npm run build" exited
 * with 1`, no stack trace. `session-only.ts` is a second, narrower Better
 * Auth instance (database + session config only, no mail-dependent
 * plugins) that validates the exact same session cookies without ever
 * importing `@entry/mail`. See that file's header comment for the full
 * writeup.
 *
 * `jwtHmac()` is kept as a second entry in case a genuine future
 * server-to-server caller is added; `localDev()` stays last for `eve dev`
 * / manual curl testing.
 */
import { eveChannel } from 'eve/channels/eve';
import { type AuthFn, jwtHmac, localDev } from 'eve/channels/auth';
import { getSessionOnly } from '@entry/auth/src/session-only';

/**
 * Authenticates the actual first-party caller: a logged-in browser hitting
 * `/eve/v1/session*` same-origin with its Better Auth session cookie.
 * Returns null (not a throw) when there's no valid session, so the walk
 * falls through to the other entries instead of hard-failing here.
 */
function betterAuthSession(): AuthFn<Request> {
  return async (request) => {
    const session = await getSessionOnly(request);
    if (!session) return null;
    return {
      attributes: {
        email: session.user.email,
        name: session.user.name,
      },
      authenticator: 'better-auth',
      principalId: session.user.id,
      principalType: 'user',
    };
  };
}

const secret = process.env.EVE_INTERNAL_JWT_SECRET;

export default eveChannel({
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
