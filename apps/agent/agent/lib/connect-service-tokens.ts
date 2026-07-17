/**
 * Real per-user OAuth for deploy-target services (2026-07-17), riding on
 * Vercel Connect (@vercel/connect), layered ON TOP of the existing
 * manual-token vault (credential-vault.ts) rather than replacing it.
 *
 * Background: Vercel Connect's "Custom OAuth" connector type looked, at
 * first read of the docs' Installations page, like it was single-tenant
 * only (one connector -> one grant, forever) — Snowflake/Salesforce/API-
 * key/Custom-OAuth are described as having "one (implicit) installation".
 * That's true for the *installation* concept specifically, but it does
 * NOT mean single-user: `startAuthorization`/`getToken` take a
 * `subject: { type: 'user', id }` with an ARBITRARY id we choose (our own
 * User.id), and Connect issues and stores one independent OAuth grant
 * PER subject id, regardless of connector type. Verified empirically
 * end-to-end in production against all three connectors below
 * (github/entry-github, vercel/entry-vercel-internal,
 * supabase/entry-supabase) before building this — each produced its own
 * per-subject consent URL and correctly gated getToken on
 * UserAuthorizationRequiredError until that specific subject completed
 * it. "Installations" (multi-tenant workspaces within ONE user's OAuth
 * grant, e.g. many Slack workspaces under one connector) is a genuinely
 * different, orthogonal axis from "which of OUR users this grant acts
 * as" (subject) — don't conflate them again.
 *
 * Why layer instead of replace: Pxxl and Sendbyte have no Vercel Connect
 * connector type available (no managed type, and standing up a Custom
 * OAuth connector needs the provider to actually run an OAuth server —
 * neither does), so they stay on the manual API-key paste vault
 * permanently. For GitHub/Vercel/Supabase we now prefer the real OAuth
 * grant (short-lived, scoped, individually revocable, never stored by
 * us at all) but keep the vault as a fallback/override so a user who
 * already pasted a token, or who wants to use a different account than
 * the one they OAuth'd with, isn't broken.
 */
import { getToken, startAuthorization, revokeToken, UserAuthorizationRequiredError } from '@vercel/connect';
import { getCredential } from './credential-vault.js';

export const CONNECT_CONNECTORS: Record<string, string> = {
  github: 'github/entry-github',
  vercel: 'vercel/entry-vercel-internal',
  supabase: 'supabase/entry-supabase',
};

/** Minimal, read/write-capable default scopes per service — narrow
 *  enough to avoid over-asking, broad enough that the agent's normal
 *  deploy/provision actions don't hit a scope wall mid-task. */
export const CONNECT_DEFAULT_SCOPES: Record<string, string[] | undefined> = {
  github: undefined, // Vercel-managed GitHub App install; scopes are fixed by the app's own permissions, not requestable here.
  vercel: undefined, // Custom OAuth against Vercel's own MCP endpoint; no separate scope list exposed.
  supabase: [
    'organizations:read',
    'projects:read',
    'projects:write',
    'database:read',
    'database:write',
    'secrets:read',
    'edge_functions:read',
    'edge_functions:write',
    'environment:read',
    'environment:write',
    'storage:read',
    'analytics:read',
  ],
};

export function hasConnectConnector(service: string): boolean {
  return service in CONNECT_CONNECTORS;
}

/** true if this user has a live OAuth grant for this service (no vault fallback considered). */
export async function isConnectAuthorized(userId: string, service: string): Promise<boolean> {
  const connector = CONNECT_CONNECTORS[service];
  if (!connector) return false;
  try {
    await getToken(connector, { subject: { type: 'user', id: userId } });
    return true;
  } catch {
    return false;
  }
}

/** Starts (or restarts) the OAuth consent flow for this user+service, returning the URL to redirect them to. */
export async function startConnectAuthorization(userId: string, service: string, callbackUrl: string) {
  const connector = CONNECT_CONNECTORS[service];
  if (!connector) throw new Error(`No Vercel Connect connector configured for "${service}".`);
  const scopes = CONNECT_DEFAULT_SCOPES[service];
  const { url } = await startAuthorization(
    connector,
    { subject: { type: 'user', id: userId }, ...(scopes ? { scopes } : {}) },
    { callbackUrl }
  );
  return url;
}

export async function disconnectConnectAuthorization(userId: string, service: string) {
  const connector = CONNECT_CONNECTORS[service];
  if (!connector) return;
  await revokeToken(connector, { subject: { type: 'user', id: userId } });
}

export interface ResolvedCredential {
  value: string;
  source: 'vault' | 'connect';
}

export interface ResolveError {
  error: string;
  needsConnect?: boolean;
}

/**
 * The single call site inject_credential (and anything else that needs a
 * live token for a deploy-target service) should use. Vault takes
 * priority — a manually pasted token always wins if present, so a user
 * who explicitly set one isn't silently switched to a different OAuth'd
 * account. Falls back to a fresh Vercel Connect token when the service
 * supports it and no vault entry exists.
 */
export async function resolveServiceCredential(
  userId: string,
  service: string,
  label = 'default'
): Promise<ResolvedCredential | ResolveError> {
  const vaultValue = await getCredential(userId, service, label);
  if (vaultValue != null) return { value: vaultValue, source: 'vault' };

  const connector = CONNECT_CONNECTORS[service];
  if (!connector) {
    return { error: `No saved credential for service "${service}". Ask the user for it, then call save_credential first.` };
  }

  try {
    const token = await getToken(connector, { subject: { type: 'user', id: userId } });
    return { value: token, source: 'connect' };
  } catch (e) {
    if (e instanceof UserAuthorizationRequiredError) {
      return {
        error: `The user hasn't connected their ${service} account yet. Ask them to connect it in Settings > Integrations (there's a real "Connect ${service}" button there now — no token needed).`,
        needsConnect: true,
      };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
