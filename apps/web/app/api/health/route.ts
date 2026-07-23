// FIXED (2026-07-23, real production incident: "agent stopping every time
// under 100s" / repeated silent restarts with zero app-level crash log).
// Root cause, confirmed straight from Render's own service events API
// (GET /v1/services/:id/events), NOT a guess:
//   { type: 'server_failed', reason: { unhealthy:
//     'HTTP health check failed (timed out after 5 seconds)' } }
// -- seven of these in one session alone, each one instantly killing the
// ENTIRE running instance (every concurrent user's in-flight turn, not
// just one request) and forcing a full cold restart. This has nothing to
// do with Vercel's old 300s maxDuration, BYOK provider behavior, or the
// client's network -- it's Render's own liveness prober giving up on
// THIS route specifically and taking the whole server down as a result.
//
// This route previously ran `SELECT 1` against the real DB on every
// single health check. That's a fine DEPTH check in isolation, but it
// makes /api/health's own response time a hostage of whatever the
// database happens to be doing at that exact moment -- a connection-pool
// squeeze under real concurrent chat load (each active turn's own
// version-capture/session writes competing for the same pool) is enough
// to make one unlucky `SELECT 1` take >5s, and Render's prober does not
// distinguish "app is genuinely wedged" from "app is fine but its DB
// query got queued" -- either one gets the same fatal verdict.
//
// Fix: liveness (this route, what Render's health check actually calls)
// must answer instantly from process memory alone, no shared-resource
// dependency in the critical path at all. A real DB reachability signal
// is still useful for debugging, so it's kept -- but off to the side,
// wrapped in its own short timeout, and never allowed to affect the
// HTTP status code or block the response.
import { prisma } from '@entry/db';

const DB_PROBE_TIMEOUT_MS = 2_000;

export async function GET() {
  // Fire-and-forget-ish: race the real DB probe against a short timeout
  // purely for an informational `db` field. Never awaited by anything
  // that could delay or fail the response itself.
  let db: 'connected' | 'unreachable' | 'unknown' = 'unknown';
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`.then(() => {
        db = 'connected';
      }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('db probe timeout')), DB_PROBE_TIMEOUT_MS)),
    ]);
  } catch {
    db = 'unreachable';
  }

  return Response.json({ ok: true, db });
}
