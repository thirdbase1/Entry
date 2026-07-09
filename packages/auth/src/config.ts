/**
 * Hardcoded auth policy constants — deliberately NOT env vars.
 *
 * These are application-level decisions (how long a session lasts, whether
 * signups are open, password length bounds), not per-deployment secrets or
 * infrastructure config. An env var for "is email verification required"
 * just moves a code decision into deploy-time config with no real benefit —
 * worse, it invites config drift (this project had exactly that bug: this
 * file's password limits and the old AUTH_PASSWORD_MIN/MAX env vars could
 * silently disagree). Single source of truth, checked into git, changed via
 * a normal code review like any other behavior change.
 *
 * If a specific deployment genuinely needs different values (e.g. a staging
 * environment with signups open), that's what git branches/environments are
 * for — not runtime env vars for what is fundamentally a code decision.
 */

/** Allow new email/password account creation. Set false to lock down to existing accounts only. */
export const AUTH_ALLOW_SIGNUP = true;

/** Require the user to verify their email before a session is created. */
export const AUTH_REQUIRE_EMAIL_VERIFICATION = true;

/** Password length bounds, enforced by Better Auth and echoed to the frontend via /api/server/config. */
export const AUTH_PASSWORD_LIMITS = {
  minLength: 8,
  maxLength: 32,
} as const;

/** Session lifetime: how long a session is valid, and how often its expiry is refreshed on use. */
export const AUTH_SESSION_CONFIG = {
  expiresIn: 60 * 60 * 24 * 15, // 15 days
  updateAge: 60 * 60 * 24 * 7, // 7 days
} as const;
