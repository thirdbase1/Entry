'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Legacy OAuth callback page — now a simple redirect.
 * Better Auth handles the entire OAuth callback flow server-side via
 * /api/auth/callback/{provider}. This page exists only to redirect
 * any legacy bookmarks to the home page.
 */
export default function OAuthCallbackPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/'); }, [router]);
  return null;
}
