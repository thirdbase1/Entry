/**
 * Single source of truth for the "known" deploy-target integrations
 * (Vercel, GitHub, Supabase, Pxxl, Sendbyte) — shared between the
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
    hint: 'Connect your own Vercel account — the agent deploys as you, with a short-lived token it never stores.',
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
    hint: 'Connect your own Supabase account — the agent provisions/manages your own projects, with a short-lived token it never stores.',
    placeholder: 'Paste your Supabase token',
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    icon: '/integration-logos/supabase.svg',
    oauth: true,
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
];

export function getKnownService(service: string): KnownService | undefined {
  return KNOWN_SERVICES.find(s => s.service === service);
}
