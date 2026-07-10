/**
 * Lightweight Better Auth instance for SESSION VERIFICATION ONLY.
 *
 * Why this exists (not just importing `auth` from ./auth.ts): every named
 * export from ./index.ts (the package's main entry) transitively imports
 * ./auth.ts, which wires emailAndPassword.sendResetPassword,
 * emailVerification.sendVerificationEmail, user.changeEmail's verification
 * callback, and the emailOTP plugin's sendVerificationOTP — every one of
 * those calls `sendMail()` from `@entry/mail` inside an object literal
 * evaluated at module load. Because they're referenced eagerly (not behind
 * a lazy dynamic import) and packages/auth's package.json doesn't declare
 * `"sideEffects": false`, webpack can't tree-shake any of it away: any
 * importer of `@entry/auth` — even one that only wants
 * `auth.api.getSession()` — drags @entry/mail's entire React-Email
 * template tree into its own server bundle.
 *
 * That's exactly what broke the apps/agent production build: adding
 * `getUserSessionFromRequest` (from ./index.ts) to the eve channel's route
 * auth pulled the whole @entry/mail tree into the agent bundle apps/web's
 * `withEve()` compiles in-process, which was enough extra weight during
 * Next's page-data collection to OOM-kill the Vercel build machine (2
 * cores / 8 GB) with zero error output — confirmed live: the production
 * deploy log went straight from "✓ Compiled successfully" /
 * "Skipping validation of types" to a bare `Command "npm run build" exited
 * with 1`, no stack trace, matching the exact silent-OOM shape
 * apps/web/next.config.ts's own comments already describe for this box.
 *
 * Session/cookie *verification* (as opposed to *issuing* a new session)
 * only needs: BETTER_AUTH_SECRET (env, shared process-wide), the same
 * Prisma-backed Session/User tables, and matching session cookie
 * config — none of which touch email. This second, narrower Better Auth
 * instance is configured with only `database` + `session`, no
 * emailAndPassword/emailOTP/social plugins, so it never imports
 * `@entry/mail` and stays cheap to bundle, while still validating the
 * exact same session cookies the full instance in ./auth.ts issues (same
 * secret, same DB, same default cookie name).
 */
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';

import { prisma } from '@entry/db';
import { AUTH_SESSION_CONFIG } from './config';

const sessionOnlyAuth = betterAuth({
  appName: 'Entry',

  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),

  // Same reasoning as ./auth.ts: let Better Auth infer the origin from the
  // live request's Host header rather than pinning to a single domain.
  baseURL: undefined,

  trustedOrigins: [
    'https://entry.oneshotsx.cv',
    'https://entry-nine-pi.vercel.app',
    'https://entry-thirdbase1s-projects.vercel.app',
    'https://entry-oneshotsx-thirdbase1s-projects.vercel.app',
  ],

  session: {
    expiresIn: AUTH_SESSION_CONFIG.expiresIn,
    updateAge: AUTH_SESSION_CONFIG.updateAge,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
});

export interface LightSessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Verifies the request's Better Auth session cookie against the database
 * and returns the minimal user identity needed for route auth. Returns
 * null for no/invalid/expired session — never throws on that path.
 */
export async function getSessionOnly(
  request: Request
): Promise<{ user: LightSessionUser } | null> {
  const result = await sessionOnlyAuth.api.getSession({ headers: request.headers });
  if (!result) return null;
  const user = result.user as any;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
  };
}
