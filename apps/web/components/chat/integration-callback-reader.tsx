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
/**
 * One-shot claim so a single OAuth callback only ever produces ONE
 * auto-sent "Connected X." message, no matter how many component
 * instances process it (2026-07-18 fix). Found the real cause of the
 * duplicate-send bug: ChatInterface can mount EITHER ChatInterfaceInner
 * (eve-root) OR DirectChatInterface (BYOK/gateway) depending on the
 * resolved model bucket, and that bucket resolution can itself flip
 * across an early render or two (see chat-interface.tsx's own
 * `crossedBucket` handling) -- each child has its OWN integrationCallback
 * effect with its OWN component-instance ref, so if the bucket flips and
 * swaps which child is mounted before the URL's query params are
 * stripped, BOTH children's effects can independently see the same
 * still-present `integration_connected=...` query string and both fire.
 * A React ref can't help here since it resets on every fresh mount --
 * sessionStorage survives the remount/swap because it's tied to the
 * browser tab, not to any one component instance. Real, but rare/narrow
 * (open only during that resolution window), which is why it read as
 * "sometimes twice" rather than "every time".
 */
export function claimIntegrationCallback(cb: IntegrationCallback): boolean {
  if (typeof window === 'undefined') return true;
  const key = `entry:ic-claimed:${cb.service}:${cb.result}`;
  try {
    if (window.sessionStorage.getItem(key)) return false;
    window.sessionStorage.setItem(key, '1');
    return true;
  } catch {
    // sessionStorage unavailable (private mode etc.) -- fall back to
    // "always allow", same as before this fix existed.
    return true;
  }
}

export function IntegrationCallbackReader({ children }: { children: (cb: IntegrationCallback | undefined) => ReactNode }) {
  const searchParams = useSearchParams();
  const service = searchParams.get('integration_connected');
  const result = searchParams.get('integration_result');
  const errorMessage = searchParams.get('integration_error') ?? undefined;

  const callback: IntegrationCallback | undefined =
    service && (result === 'connected' || result === 'error') ? { service, result, errorMessage } : undefined;

  return <>{children(callback)}</>;
}
