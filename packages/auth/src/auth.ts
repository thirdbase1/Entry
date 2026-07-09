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
import { magicLink } from 'better-auth/plugins';
import { nextCookies } from 'better-auth/next-js';

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

  // Vercel auto-injects VERCEL_PROJECT_PRODUCTION_URL on every deployment —
  // no manual env var needed. Falls back to Better Auth's own request-header
  // inference for local dev (no env var set at all locally).
  baseURL: process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : undefined,

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
  },

  // Plugins
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        // Extract the token from the URL for the OTP code display
        const urlObj = new URL(url);
        const token = urlObj.searchParams.get('token') ?? '';
        await sendMail({ name: 'SignIn', to: email, props: { url, otp: token } });
      },
    }),
    nextCookies(), // Must be last — auto-sets cookies in server actions
  ],
});
