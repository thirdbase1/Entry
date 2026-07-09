'use client';

/**
 * Ported 1:1 from pages/magic-link.tsx.
 * Standalone magic-link verification page — handles email+token from a
 * magic link URL, verifies via the auth store, then redirects.
 */
import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useAuthStore } from '@/store/auth';

function MagicLinkPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const auth = useAuthStore();

  const triggered = useRef(false);

  useEffect(() => {
    if (triggered.current) return;
    triggered.current = true;

    const email = params.get('email');
    const token = params.get('token');
    const redirectUri = params.get('redirect_uri') || '/';

    if (!email || !token) {
      router.replace('/sign-in?error=Invalid%20magic%20link');
      return;
    }

    void auth
      .verifyMagicLink(email, token)
      .then(() => {
        router.replace(redirectUri);
      })
      .catch((e: Error) => {
        router.replace(`/sign-in?error=${encodeURIComponent(e.message)}`);
      });
  }, [auth, router, params]);

  return null;
}

export default function MagicLinkPage() {
  return (
    <Suspense fallback={null}>
      <MagicLinkPageInner />
    </Suspense>
  );
}
