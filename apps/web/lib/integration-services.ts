/**
 * Single source of truth for the "known" deploy-target integrations
 * (Vercel, GitHub, Supabase, Pxxl, Sendbyte, npm) — shared between the
 * Settings > Integrations page and the in-chat connect card
 * (renderers/integration-connect-card.tsx) so the two surfaces never
 * drift apart on name/icon/hint/oauth-vs-token.
 */
export interface KnownService {
  service: string;
  name: string;
  hint: string;
  placeholder: string;
  tokenUrl: string;
  /** Real brand logo, served from /public/integration-logos. */
  icon: string;
  iconBg?: string;
  /** Has a real one-click OAuth connect flow (github, vercel, supabase).
   *  Everything else is token-paste only. */
  oauth?: boolean;
}

export const KNOWN_SERVICES: KnownService[] = [
  {
    service: 'vercel',
    name: 'Vercel',
    // 2026-07-23: back to one-click OAuth -- but now via a real,
    // standalone "Sign in with Vercel" OAuth+PKCE app (vercel-oauth
    // routes), NOT the old @vercel/connect SDK (which only ever worked
    // when this app itself ran on Vercel). See connect-service-tokens.ts's
    // DIRECT_OAUTH_SERVICES comment.
    hint: 'Connect your own Vercel account — the agent deploys as you.',
    placeholder: 'Paste your Vercel token',
    tokenUrl: 'https://vercel.com/account/tokens',
    icon: '/integration-logos/vercel.svg',
    oauth: true,
  },
  {
    service: 'github',
    name: 'GitHub',
    hint: 'Connect your own GitHub account — the agent pushes/opens PRs as you, with a short-lived token it never stores.',
    placeholder: 'Paste your GitHub token',
    tokenUrl: 'https://github.com/settings/tokens',
    icon: '/integration-logos/github.svg',
    oauth: true,
  },
  {
    service: 'supabase',
    name: 'Supabase',
    // 2026-07-23: token-paste only now -- see the vercel entry above for why.
    hint: 'Personal access token — used to provision/manage your own Supabase projects.',
    placeholder: 'Paste your Supabase token',
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    icon: '/integration-logos/supabase.svg',
  },
  {
    service: 'pxxl',
    name: 'Pxxl',
    hint: 'Scoped API key from Dashboard > API Keys — used to deploy to your own Pxxl workspace.',
    placeholder: 'Paste your Pxxl API key',
    tokenUrl: 'https://pxxl.app/dashboard/keys',
    icon: '/integration-logos/pxxl.png',
  },
  {
    service: 'sendbyte',
    name: 'Sendbyte',
    hint: 'API key — used to send transactional email through your own Sendbyte account.',
    placeholder: 'Paste your Sendbyte API key',
    tokenUrl: 'https://app.sendbyte.africa/keys/',
    icon: '/integration-logos/sendbyte.svg',
  },
  {
    service: 'npm',
    name: 'npm',
    hint: 'Access token from your own npm account — used to publish/update packages to the npm registry as you.',
    placeholder: 'Paste your npm access token',
    tokenUrl: 'https://docs.npmjs.com/creating-and-viewing-access-tokens',
    icon: '/integration-logos/npm.svg',
  },
];

export function getKnownService(service: string): KnownService | undefined {
  return KNOWN_SERVICES.find(s => s.service === service);
}
