'use client';

/**
 * Ported 1:1 from pages/redirect.tsx.
 * Trusted-domain redirect proxy page. Only redirects to whitelisted domains
 * to prevent open-redirect attacks from chat/LLM-generated links.
 */
import { useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const trustedDomains = [
  'google.com',
  'stripe.com',
  'github.com',
  'twitter.com',
  'discord.gg',
  'youtube.com',
  't.me',
  'reddit.com',
];

function RedirectProxyPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const redirectUri = searchParams.get('redirect_uri');

  const allow = useMemo(() => {
    if (!redirectUri) return false;
    try {
      const target = new URL(redirectUri);
      if (
        target.hostname === window.location.hostname ||
        trustedDomains.some(domain =>
          new RegExp(`.?${domain}$`).test(target.hostname)
        )
      ) {
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }, [redirectUri]);

  useEffect(() => {
    if (allow && redirectUri) {
      window.location.href = redirectUri;
    }
  }, [allow, redirectUri]);

  useEffect(() => {
    if (!allow) {
      router.replace('/404');
    }
  }, [allow, router]);

  if (allow) {
    return null;
  }

  return null;
}

export default function RedirectProxyPage() {
  return (
    <Suspense fallback={null}>
      <RedirectProxyPageInner />
    </Suspense>
  );
}
