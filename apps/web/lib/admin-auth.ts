/**
 * Timing-safe bearer-token check for admin/diagnostic routes.
 *
 * HARDENED (2026-07-18, BYOK-key security pass): every admin/diag route
 * was comparing `authHeader === \`Bearer ${ADMIN_DEBUG_TOKEN}\`` with
 * plain `===`, a naive string comparison that returns as soon as the
 * first differing character is found. That timing difference is
 * measurable in principle (classic timing side-channel), and several of
 * these routes gate real decrypted BYOK API key material or user PII
 * behind exactly this one check -- worth closing properly rather than
 * leaving a real secret behind a non-constant-time compare, even though
 * exploiting it remotely over today's network jitter is impractical.
 * `crypto.timingSafeEqual` requires equal-length buffers, so length is
 * checked separately first (which itself leaks only the token's length,
 * not its content -- the standard, accepted tradeoff for this pattern).
 */
import { timingSafeEqual } from 'node:crypto';

export function isAdminBearerAuthorized(req: Request): boolean {
  const expected = process.env.ADMIN_DEBUG_TOKEN;
  if (!expected) return false;

  const authHeader = req.headers.get('authorization') || '';
  const expectedHeader = `Bearer ${expected}`;

  const actual = Buffer.from(authHeader, 'utf8');
  const wanted = Buffer.from(expectedHeader, 'utf8');
  if (actual.length !== wanted.length) return false;

  return timingSafeEqual(actual, wanted);
}
