/**
 * Off-Vercel (Pxxl) agent host wiring -- part of the Pxxl migration, see
 * PXXL_MIGRATION.md. Both exports are no-ops (return undefined) until
 * NEXT_PUBLIC_EVE_AGENT_HOST is actually set in the Vercel env, so this
 * file is a pure feature flag: shipping it changes nothing about today's
 * in-process (`withEve()`) behavior until that env var is deliberately
 * set, after the standalone Pxxl deployment is verified healthy.
 */

/** Base URL of the standalone eve agent (e.g. https://entry-agent.pxxl.pro), or undefined to keep using the in-process same-origin mount. */
export const EVE_AGENT_HOST = process.env.NEXT_PUBLIC_EVE_AGENT_HOST || undefined;

/**
 * Fetches a fresh short-lived bearer token from this app's own
 * /api/agent-token route (which verifies the real Better Auth session
 * server-side, then signs a JWT the agent's jwtHmac() channel auth
 * verifies). Only called when EVE_AGENT_HOST is set -- see
 * `eve/client`'s `ClientAuth.bearer` docs: this thunk is invoked fresh
 * before every request/reconnect, so a 5-minute token expiry is fine.
 */
export async function fetchAgentBearerToken(): Promise<string> {
  const res = await fetch('/api/agent-token', { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Failed to mint agent token (${res.status})`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}
