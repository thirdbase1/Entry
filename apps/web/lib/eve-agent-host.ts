/**
 * HARD-RETIRED (2026-07-22, real confirmed root-cause bug, not a
 * hypothetical): NEXT_PUBLIC_EVE_AGENT_HOST was found still SET in Vercel
 * production (added during the abandoned Pxxl/Fly worker migration,
 * ~2 days prior), silently pointing at that dead, OOM-killed host. Because
 * this is a NEXT_PUBLIC_ var, its value gets inlined into the CLIENT
 * bundle at build time -- so every deploy built while it was set shipped
 * a frontend where BOTH chat-interface.tsx's legacy eve path AND (the
 * actually-live one) direct-chat-interface.tsx's DefaultChatTransport
 * pointed every single message send at `${EVE_AGENT_HOST}/message` on
 * that dead external host instead of this deployment's own same-origin
 * /api/direct/chat -- entirely explaining "messages stop instantly",
 * "BYOK never reaches the endpoint", and "nothing saves": the request
 * never reached THIS app's server code at all, no matter how correct
 * route.ts's own logic was (see its 2026-07-21 preSave-ordering fix,
 * which was real and worth keeping, but was likely never even being
 * exercised by real user traffic while this was armed).
 *
 * This file is now a permanent dead-end, not a feature flag: both
 * exports are hardcoded so the kill-switch can never be re-armed again
 * just by an env var reappearing (accidentally re-added, copied from an
 * old .env, restored from a stale Vercel env snapshot, etc.) -- it would
 * need an actual code change (reverting this file) to ever matter again.
 * The abandoned Pxxl/Fly standalone-worker deploy files this referred to
 * are deleted outright (see repo root / .github/workflows -- this was
 * that migration's off-ramp, not a still-planned destination).
 */

/** Permanently undefined -- always same-origin (/api/direct/chat, this
 *  deployment's own Vercel Function), never a standalone external host. */
export const EVE_AGENT_HOST: string | undefined = undefined;

/** Dead code kept only so any stray import doesn't hard-crash the build;
 *  never actually called now that both call sites are gated on
 *  EVE_AGENT_HOST (always undefined, see above). */
export async function fetchAgentBearerToken(): Promise<string> {
  throw new Error('fetchAgentBearerToken is retired -- EVE_AGENT_HOST is permanently disabled.');
}
