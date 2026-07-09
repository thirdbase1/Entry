import { NextResponse } from 'next/server';

/**
 * Wraps a route handler so any thrown error (config errors like a missing
 * BYOK_ENCRYPTION_KEY, upstream provider failures, etc.) always turns into
 * a clean JSON error response instead of an opaque empty-body 500 that
 * breaks `res.json()` on the client.
 */
export function withApiErrorHandling<T extends (...args: any[]) => Promise<Response>>(handler: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error('[api-error]', err);
      const message = err instanceof Error ? err.message : 'Internal server error';
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }) as T;
}
