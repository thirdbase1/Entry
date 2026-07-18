'use client';

import { useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';

export interface IntegrationCallback {
  service: string;
  result: 'connected' | 'error';
  errorMessage?: string;
}

/**
 * Reads `?integration_connected=<service>&integration_result=connected|error`
 * (set by github-oauth/callback and connect/start's returnTo redirect,
 * 2026-07-18) and hands it to ChatInterface as a plain object. Isolated
 * in its own tiny component (rather than reading useSearchParams directly
 * in the page) purely so only THIS leaf needs the Suspense boundary
 * Next's app router requires for that hook, matching the existing
 * ChatPageHeader pattern.
 */
export function IntegrationCallbackReader({ children }: { children: (cb: IntegrationCallback | undefined) => ReactNode }) {
  const searchParams = useSearchParams();
  const service = searchParams.get('integration_connected');
  const result = searchParams.get('integration_result');
  const errorMessage = searchParams.get('integration_error') ?? undefined;

  const callback: IntegrationCallback | undefined =
    service && (result === 'connected' || result === 'error') ? { service, result, errorMessage } : undefined;

  return <>{children(callback)}</>;
}
