/**
 * Better Auth `secondaryStorage` adapter, backed by the same Upstash Redis
 * connection `@entry/cache` already uses elsewhere in the app.
 *
 * WHY THIS EXISTS (real bug, found + verified 2026-07-14): Better Auth
 * ships built-in rate limiting, ALREADY enabled by default in production
 * (`rateLimit.enabled ?? isProduction`), and the `emailOTP` plugin already
 * defines its own per-endpoint rules (3 requests / 60s on send-verification-
 * otp, sign-in, etc — see node_modules/better-auth/dist/plugins/email-otp/
 * index.mjs). None of that was actually doing anything in production,
 * though: with no `secondaryStorage` configured, Better Auth's rate-limit
 * counters default to in-memory storage — and Vercel Functions are
 * stateless per invocation (no shared process between requests), so every
 * single request started counting from zero. Confirmed this hands-on: a
 * raw `curl -X POST .../api/auth/email-otp/send-verification-otp` on the
 * live production deployment returned a clean `200 {"success":true}` with
 * zero friction, repeatable indefinitely — a real, exploitable gap (OTP
 * email-bombing/cost abuse, not a hypothetical).
 *
 * Fix (per Better Auth's own documented "Using Secondary Storage" recipe,
 * docs.better-auth.com/docs/concepts/database#secondary-storage — the
 * exact `SecondaryStorage` interface below is copied from that doc, not
 * guessed): once `secondaryStorage` is configured, Better Auth's rate
 * limiter automatically switches its storage to Redis
 * (`storage: options.rateLimit?.storage || (options.secondaryStorage ?
 * "secondary-storage" : "memory")` — see
 * node_modules/better-auth/dist/context/create-context.mjs), with zero
 * further config needed — the existing per-endpoint rules just start being
 * enforced for real.
 *
 * Deliberately scoped narrow: configuring `secondaryStorage` ALSO opts
 * Better Auth into storing live session data in Redis instead of the DB
 * (see docs on secondary storage — sessions, verification records, and
 * rate-limit counters all move by default). That's a bigger behavior
 * change than "fix rate limiting", so `auth.ts` explicitly sets
 * `session.storeSessionInDatabase: true` alongside this to keep sessions
 * on Postgres exactly as before — only rate-limit counters (and any
 * verification-token caching Better Auth chooses to do internally) move to
 * Redis. Not a guess: confirmed the `storeSessionInDatabase` escape hatch
 * exists by reading node_modules/better-auth/dist/db/internal-adapter.mjs
 * directly (`if (!secondaryStorage || options.session?.storeSessionInDatabase)
 * ... deleteManyWithHooks(...)"session"...` / `if (secondaryStorage &&
 * !storeInDb) { ... generate an in-memory-only session id ... }`).
 */
import { getRawRedis } from '@entry/cache';

export const redisSecondaryStorage = {
  async get(key: string): Promise<string | null> {
    const value = await getRawRedis().get(key).catch(() => null);
    return value ?? null;
  },
  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await getRawRedis().set(key, value, 'EX', ttl);
    } else {
      await getRawRedis().set(key, value);
    }
  },
  async delete(key: string): Promise<void> {
    await getRawRedis().del(key);
  },
};
