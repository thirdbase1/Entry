/**
 * Better Auth server instance for Entry.
 *
 * Replaces the entire hand-rolled auth system (custom JWT sessions, EC P-256
 * private key, manual cookie management, verification tokens, OAuth flow)
 * with Better Auth — a framework that handles all of this declaratively.
 *
 * What Better Auth gives us:
 * - Email/password auth with bcrypt-hashed passwords stored in the Account table
 * - Session management (cookie-based, auto-refreshing, DB-backed)
 * - Email verification flow
 * - Social sign-on (Google, GitHub) — replaces packages/oauth
 * - Magic link sign-in — replaces our hand-rolled magic-link routes
 * - Change email / change password flows
 * - Prisma adapter — uses our existing PrismaClient
 *
 * Real env vars needed (down to 1 truly required + optional OAuth provider keys):
 * - BETTER_AUTH_SECRET — random 32+ char string (Better Auth reads this env
 *   var automatically, no code needed to wire it up)
 * - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
 *   — optional, only if social sign-in is enabled
 *
 * Everything else that was previously a custom env var
 * (AUTH_ALLOW_SIGNUP, AUTH_REQUIRE_EMAIL_VERIFICATION, AUTH_PASSWORD_MIN/MAX,
 * AUTH_SESSION_TTL_SEC/TTR_SEC) is a code-level policy decision, not deploy
 * config — those are now hardcoded constants in ./config.ts, and
 * `disableSignUp` uses Better Auth's own NATIVE option (confirmed against
 * better-auth.com/docs/reference/options — emailAndPassword.disableSignUp
 * is built in; no custom hook/middleware needed, unlike an earlier pass here
 * that hand-rolled it before this was double-checked against the real docs).
 *
 * baseURL: no BETTER_AUTH_URL env var needed either — Vercel auto-injects
 * VERCEL_PROJECT_PRODUCTION_URL on every deployment, so we derive it from
 * that; Better Auth's own request-header inference covers local dev.
 *
 * Better Auth is joining Vercel (announced on their homepage), so this is
 * the platform-native auth choice for a Vercel-deployed Next.js app.
 */
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { emailOTP } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';

import { redisSecondaryStorage } from './redis-secondary-storage';

import { prisma } from '@entry/db';
import { sendMail } from '@entry/mail';
import {
  AUTH_ALLOW_SIGNUP,
  AUTH_REQUIRE_EMAIL_VERIFICATION,
  AUTH_PASSWORD_LIMITS,
  AUTH_SESSION_CONFIG,
} from './config';

export const auth = betterAuth({
  appName: 'Entry',

  // Prisma adapter — uses our existing PrismaClient with the v7 driver adapter.
  // Better Auth's expected tables (User, Session, Account, Verification) are
  // defined in packages/db/prisma/schema.prisma with field mappings via @map.
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),

  // Deliberately NOT pinned to VERCEL_PROJECT_PRODUCTION_URL: that env var
  // is the project's raw *.vercel.app domain and does NOT reflect a custom
  // domain (e.g. entry.oneshotsx.cv) aliased on top of it. Pinning baseURL
  // to the wrong domain caused a real bug: Google OAuth would complete on
  // the vercel.app domain, but the session cookie set there is invisible
  // once the user lands back on the custom domain (different eTLD, cookies
  // never share) -- the app then sees "no session" and bounces to the
  // landing page instead of the dashboard, even though login succeeded.
  //
  // Better Auth's own request-Host inference (the old `baseURL: undefined`)
  // still works fine, but it also unconditionally logs a startup WARN
  // ("Base URL is not set...") on every cold start — noisy, and easy to
  // mistake for a real error in production logs. Better Auth has a
  // purpose-built fix for exactly this multi-host case: the "dynamic
  // baseURL" object form (allowedHosts) below. It resolves the same way
  // (per-request Host header) but against an explicit allowlist instead of
  // trusting any Host header blindly, AND suppresses that warning entirely
  // since it's a deliberate, validated config rather than "unset". Zero
  // env var dependency either way, in both prod and local dev.
  baseURL: {
    allowedHosts: [
      'entry.oneshotsx.cv',
      'entry-nine-pi.vercel.app',
      'entry-thirdbase1s-projects.vercel.app',
      'entry-oneshotsx-thirdbase1s-projects.vercel.app',
      '*.vercel.app', // preview deployments (one per PR/branch)
      'entry-agent-worker.onrender.com', // Render web service (2026-07-22 Vercel->Render migration)
      'entry.pxxl.pro', // Pxxl web service (2026-07-24 Render->Pxxl migration)
      'localhost:*', // local dev
    ],
  },

  // Explicitly trust every domain this app is actually reachable from, so
  // OAuth state-cookie / origin checks never reject a legitimate request
  // regardless of which one baseURL inference picks for a given request.
  trustedOrigins: [
    'https://entry.oneshotsx.cv',
    'https://entry-nine-pi.vercel.app',
    'https://entry-thirdbase1s-projects.vercel.app',
    'https://entry-oneshotsx-thirdbase1s-projects.vercel.app',
    'https://entry-agent-worker.onrender.com',
    'https://entry.pxxl.pro',
  ],

  // Email/password authentication
  emailAndPassword: {
    enabled: true,
    disableSignUp: !AUTH_ALLOW_SIGNUP, // native Better Auth option — no custom hook needed
    minPasswordLength: AUTH_PASSWORD_LIMITS.minLength,
    maxPasswordLength: AUTH_PASSWORD_LIMITS.maxLength,
    requireEmailVerification: AUTH_REQUIRE_EMAIL_VERIFICATION,
    sendResetPassword: async ({ user, url }) => {
      await sendMail({ name: 'SetPassword', to: user.email, props: { url } });
    },
  },

  // Email verification
  emailVerification: {
    sendOnSignUp: true, // BUG FIX: without this, better-auth never actually
    // sends the verification email on sign-up, yet requireEmailVerification
    // above still blocks sign-in for unverified users — a total lockout for
    // every new email/password account with no way to self-recover.
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail({ name: 'VerifyEmail', to: user.email, props: { url } });
    },
  },

  // Change email flow
  user: {
    changeEmail: {
      enabled: true,
      sendChangeEmailVerification: async ({ user, url }: { user: any; url: string }) => {
        await sendMail({ name: 'VerifyChangeEmail', to: user.email, props: { url } });
      },
    },
    deleteUser: {
      enabled: true,
    },
  },

  // Social providers — replaces packages/oauth entirely
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
    },
  },

  // Session config — hardcoded policy, see ./config.ts
  session: {
    expiresIn: AUTH_SESSION_CONFIG.expiresIn,
    updateAge: AUTH_SESSION_CONFIG.updateAge,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes — avoids DB hit on every request
    },
    // Keep sessions on Postgres exactly as before, even though
    // `secondaryStorage` (below) is now configured — see
    // ./redis-secondary-storage.ts's file comment for why this is needed
    // (secondaryStorage would otherwise silently move live session storage
    // to Redis too, a bigger behavior change than "fix rate limiting").
    storeSessionInDatabase: true,
  },

  // Real distributed rate limiting (2026-07-14 fix — see
  // ./redis-secondary-storage.ts for the full story: Better Auth's
  // built-in rate limiter was already enabled in production and the
  // emailOTP plugin already had per-endpoint rules, but with no
  // secondaryStorage configured those counters lived in each serverless
  // invocation's own memory and never persisted between requests, so they
  // did nothing on Vercel. This one line makes them real.
  //
  // CONDITIONAL (2026-07-24, real prod crash): no Upstash/Redis instance
  // has ever actually been provisioned for this project — confirmed
  // UPSTASH_REDIS_URL/REDIS_URL/KV_URL are unset in every real env source
  // (Render's live service env, every pulled .env snapshot). Unconditionally
  // wiring secondaryStorage made `getRawRedis()` throw synchronously on the
  // very first auth request (sign-in, session check, anything hitting
  // Better Auth's rate limiter), a hard crash with zero graceful fallback.
  // The underlying reason this existed — Vercel Functions being stateless
  // per invocation, so in-memory rate-limit counters reset every request —
  // no longer applies now that this runs as a persistent long-lived server
  // (Render/Pxxl): a single Node process stays alive across requests, so
  // Better Auth's default in-memory rate-limit storage genuinely persists
  // within that process already. Only wire the Redis-backed storage when a
  // real connection string is actually configured; otherwise fall back to
  // Better Auth's built-in in-memory limiter (still real protection on a
  // persistent server, just not shared across multiple replicas).
  ...(process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL || process.env.KV_URL
    ? { secondaryStorage: redisSecondaryStorage }
    : {}),

  // Plugins
  plugins: [
    // Real one-time-code sign-in (replaces the earlier magicLink plugin,
    // which issues a long opaque URL token — the frontend's sign-in UI is a
    // 6-digit CodeInput box, which magicLink's token was never shaped to
    // fit, so a user could never actually complete sign-in by typing it.
    // emailOTP generates a real N-digit numeric code purpose-built for
    // manual entry, and creates the user on first verify (matching
    // AUTH_ALLOW_SIGNUP) when they don't already have an account.
    emailOTP({
      disableSignUp: !AUTH_ALLOW_SIGNUP,
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== 'sign-in') return; // this app only uses the sign-in flow today
        const sent = await sendMail({ name: 'SignIn', to: email, props: { otp } });
        if (!sent) {
          // sendMail swallows failures by design (never blocks the auth
          // request), but silently pretending the code went out when it
          // didn't is exactly the bug that made sign-in look broken with
          // zero error surfaced anywhere — at minimum, log loudly so this
          // shows up in function logs instead of vanishing.
          console.error(`[auth] sign-in OTP email to ${email} did NOT send — check SENDBYTE_API_KEY/SENDBYTE_FROM_DOMAIN`);
        }
      },
    }),
    nextCookies(), // Must be last — auto-sets cookies in server actions
  ],
});
