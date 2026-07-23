/**
 * Real per-user OAuth for deploy-target services, riding on Vercel Connect
 * (@vercel/connect), layered ON TOP of the existing manual-token vault
 * (credential-vault.ts) rather than replacing it.
 *
 * CORRECTED 2026-07-18 (previous version of this comment was wrong about
 * GitHub specifically -- leaving this note so it doesn't get re-asserted):
 * `subject: { type: 'user', id }` genuinely does give each of our users
 * their own independent OAuth grant for single-tenant connector types
 * (Custom OAuth: vercel/entry-vercel-internal, supabase/entry-supabase --
 * confirmed empirically, each subject id gets its own consent URL and is
 * correctly gated on UserAuthorizationRequiredError). GitHub is different:
 * it's a genuinely multi-tenant connector type where "installation" (which
 * GitHub org/account) is a SEPARATE axis from "subject", and real
 * installation-scoped tokens require `subject: { type: 'app' },
 * installationId` -- seeing UserAuthorizationRequiredError clear for a
 * given subject id does NOT mean that subject has its own installation;
 * omitting installationId silently falls back to the connector's single
 * default installation (see resolveGithubInstallationId below for the
 * fix and packages/db's User.githubInstallationId for where it's stored).
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
import { getToken, getTokenResponse, startAuthorization, revokeToken, UserAuthorizationRequiredError, ConnectorInstallationRequiredError } from '@vercel/connect';
import { getCredential } from './credential-vault.js';
import { prisma } from '@entry/db';

// UPDATED 2026-07-23 (real user decision, follows the Vercel->Render
// migration): 'vercel' and 'supabase' removed from here entirely --
// there is no code-level way to make Vercel Connect work off-Vercel (see
// isVercelRuntime's comment above), and this app doesn't even deploy
// through Vercel or provision Supabase anymore (Render + Neon now).
// Rather than leave a permanently-broken OAuth path guarded by a
// runtime check, both now go through the exact same token-paste flow as
// Pxxl/Sendbyte/npm -- see integration-services.ts's `oauth` flag (now
// false for these two) and resolveServiceCredential below, which already
// falls through to a clean token-only `needsConnect` response the moment
// a service isn't in this map. github stays -- it has its own real,
// working direct-OAuth flow (github-oauth/start+callback) that never
// depended on Vercel Connect in the first place.
export const CONNECT_CONNECTORS: Record<string, string> = {
  github: 'github/entry-github',
};

/** Minimal, read/write-capable default scopes per service — narrow
 *  enough to avoid over-asking, broad enough that the agent's normal
 *  deploy/provision actions don't hit a scope wall mid-task. */
export const CONNECT_DEFAULT_SCOPES: Record<string, string[] | undefined> = {
  github: undefined, // Vercel-managed GitHub App install; scopes are fixed by the app's own permissions, not requestable here.
};

export function hasConnectConnector(service: string): boolean {
  return service in CONNECT_CONNECTORS;
}

/**
 * ADDED 2026-07-23 (real user-reported bug): Vercel Connect
 * (@vercel/connect) only works when this app is actually running ON
 * Vercel with a linked project -- every call authenticates itself to
 * Connect's API via a `x-vercel-oidc-token` header that Vercel's own
 * runtime injects automatically and NO OTHER HOST CAN PROVIDE. Since the
 * 2026-07-22/23 migration to Render (see DEPLOY.md), every one of these
 * calls was failing with a raw, confusing
 * `VercelOidcTokenError: ... Have you linked your project with vc link?`
 * bubbling straight to the user for "vercel"/"supabase" connect attempts
 * (github already has its own direct-OAuth bypass -- see
 * github-oauth/start+callback routes -- so it's unaffected by this).
 *
 * Fix: detect up front (Vercel sets `VERCEL=1` in every one of its own
 * runtimes; Render never does) and fail fast with one clear, honest
 * message instead of letting the SDK's own confusing OIDC error surface.
 * There is no code-level fix that makes Connect itself work off-Vercel --
 * this is a genuine platform capability Entry lost by moving to Render,
 * not a bug in how we call it.
 */
function isVercelRuntime(): boolean {
  return process.env.VERCEL === '1';
}

const CONNECT_UNAVAILABLE_OFF_VERCEL =
  'One-click connect for this service needs Entry to be running on Vercel, which it no longer is. Use the manual token field instead.';


/**
 * GitHub-specific (2026-07-18 fix): GitHub is a multi-tenant Vercel Connect
 * connector type -- "installation" (which GitHub org/account) is a
 * completely separate axis from "subject" (which of our users is asking).
 * A token request that doesn't pass `installationId` silently falls back to
 * the connector's single *default* installation -- in practice this meant
 * every user's GitHub connection was actually resolving to the SAME
 * installation (whichever GitHub account happened to install the app
 * first), never to that specific user's own account. Real installation-
 * scoped tokens need `subject: { type: 'app' }, installationId` (per Vercel
 * Connect's own eve helper -- GitHub installation tokens are app-scoped),
 * not `subject: { type: 'user', id }`.
 *
 * This resolves + persists the installationId a user's own OAuth grant
 * corresponds to, the first time it's needed, so all following calls use
 * the correct per-user installation instead of the shared default.
 */
export async function resolveGithubInstallationId(userId: string): Promise<string | null> {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { githubInstallationId: true } });
  if (existing?.githubInstallationId) return existing.githubInstallationId;

  // Not captured yet -- ask Connect what installation this user's own grant
  // (identified via the user-subject OAuth token they completed) maps to.
  const resp = await getTokenResponse(CONNECT_CONNECTORS.github, { subject: { type: 'user', id: userId } });
  if (!resp.installationId) return null;
  await prisma.user.update({ where: { id: userId }, data: { githubInstallationId: resp.installationId } });
  return resp.installationId;
}

/** true if this user has a live OAuth grant for this service (no vault fallback considered). */
export async function isConnectAuthorized(userId: string, service: string): Promise<boolean> {
  const connector = CONNECT_CONNECTORS[service];
  if (!connector) return false;
  if (!isVercelRuntime()) return false;
  try {
    if (service === 'github') {
      const installationId = await resolveGithubInstallationId(userId);
      if (!installationId) return false;
      await getToken(connector, { subject: { type: 'app' }, installationId });
      return true;
    }
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
  if (!isVercelRuntime()) throw new Error(CONNECT_UNAVAILABLE_OFF_VERCEL);
  const scopes = CONNECT_DEFAULT_SCOPES[service];
  // GitHub specifically needs to go through the App INSTALLATION step (repo picker + permission
  // grant), not just OAuth sign-in -- see file header comment. Requesting it here means the consent
  // URL Connect returns takes the user through "Install & Authorize" instead of a bare "Authorize".
  const authorizationDetails =
    service === 'github'
      ? ([{ type: 'github_app_installation' as const, permissions: ['contents'], repositories: 'all' as const }])
      : undefined;
  // 2026-07-18: GitHub's connector type does NOT support the redirect-back
  // "stateless callback" mechanism the other connectors use -- passing
  // callbackUrl here makes Vercel's own hosted callback page fail with
  // "Connector type 'github' does not support stateless callbacks"
  // (confirmed live: happened on every attempt, fresh or not). For github,
  // omit callbackUrl entirely; Vercel then serves its own "you can close
  // this window" confirmation page instead, and the caller (our frontend)
  // is expected to detect completion itself -- see the popup+poll flow in
  // integrations-section.tsx's OAuthIntegrationCard rather than relying on
  // a query-string redirect back to our own /settings page.
  const { url } = await startAuthorization(
    connector,
    {
      subject: { type: 'user', id: userId },
      ...(scopes ? { scopes } : {}),
      ...(authorizationDetails ? { authorizationDetails } : {}),
    },
    service === 'github' ? {} : { callbackUrl }
  );
  return url;
}

export async function disconnectConnectAuthorization(userId: string, service: string) {
  const connector = CONNECT_CONNECTORS[service];
  if (!connector) return;
  if (!isVercelRuntime()) return;
  if (service === 'github') {
    // GitHub's connector reports supportsRevocation: false (installations
    // are only removed from the provider side or the Vercel dashboard, not
    // via this API) -- clear our own stored mapping so the next connect
    // attempt re-resolves a fresh installationId instead of reusing a stale
    // one, and skip the (unsupported) revoke call.
    await prisma.user.update({ where: { id: userId }, data: { githubInstallationId: null } }).catch(() => {});
    return;
  }
  await revokeToken(connector, { subject: { type: 'user', id: userId } });
}

export interface ResolvedCredential {
  value: string;
  source: 'vault' | 'connect';
}

export interface ResolveError {
  error: string;
  needsConnect?: boolean;
  /** Which service this is about — lets the chat UI render the right
   *  inline connect card (icon, name) instead of a plain text bubble. */
  service?: string;
  /** "oauth" -> chat shows a Connect/Cancel button that opens the real
   *  one-click flow. "token" -> chat shows an inline paste-token box
   *  (still Connect/Cancel, "Connect" here just means "save + continue"). */
  connectMode?: 'oauth' | 'token';
}

/**
 * The single call site inject_credential (and anything else that needs a
 * live token for a deploy-target service) should use. Vault takes
 * priority — a manually pasted OR OAuth-obtained token always wins if
 * present (github's direct-OAuth flow also lands here — see
 * github-oauth/callback/route.ts), so a user who explicitly set one
 * isn't silently switched to a different account. Falls back to a fresh
 * Vercel Connect token when the service supports it (vercel/supabase)
 * and no vault entry exists.
 *
 * 2026-07-18: every "not connected" branch now returns `needsConnect`
 * (previously only the Connect-backed services did) plus `service` +
 * `connectMode`, so the chat's inline IntegrationConnectCard can render
 * for ANY missing credential — token-only services (Pxxl, Sendbyte,
 * custom) included — instead of the model asking the user to paste a
 * secret directly into the chat text box.
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
    return {
      error: `The user hasn't connected "${service}" yet. A connect card will be shown in the chat for them to paste a token — do not ask them to type the secret directly into chat.`,
      needsConnect: true,
      service,
      connectMode: 'token',
    };
  }

  try {
    if (service === 'github') {
      const installationId = await resolveGithubInstallationId(userId);
      if (!installationId) {
        return {
          error: `The user hasn't connected their GitHub account yet. A connect card will be shown in the chat.`,
          needsConnect: true,
          service,
          connectMode: 'oauth',
        };
      }
      const token = await getToken(connector, { subject: { type: 'app' }, installationId });
      return { value: token, source: 'connect' };
    }
    const token = await getToken(connector, { subject: { type: 'user', id: userId } });
    return { value: token, source: 'connect' };
  } catch (e) {
    if (e instanceof ConnectorInstallationRequiredError) {
      return {
        error:
          `The user connected their ${service} identity but never completed the app-installation step ` +
          `(picking repos + granting write access), so this token has no actual repo permissions -- any ` +
          `push/write will 403 regardless of what we request. A connect card will be shown in the chat for ` +
          `them to redo it through the install flow.`,
        needsConnect: true,
        service,
        connectMode: 'oauth',
      };
    }
    if (e instanceof UserAuthorizationRequiredError) {
      return {
        error: `The user hasn't connected their ${service} account yet. A connect card will be shown in the chat.`,
        needsConnect: true,
        service,
        connectMode: 'oauth',
      };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
