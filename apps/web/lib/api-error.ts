import { NextResponse } from 'next/server';
import { logError } from '@entry/db/error-log';

/**
 * Wraps a route handler so any thrown error (config errors like a missing
 * BYOK_ENCRYPTION_KEY, upstream provider failures, etc.) always turns into
 * a clean JSON error response instead of an opaque empty-body 500 that
 * breaks `res.json()` on the client.
 *
 * Also persists every caught error via logError (2026-07-11, "log
 * everything so we can spot error once") -- this is what catches
 * PRE-FLIGHT failures specifically (bad BYOK key, unknown model slug,
 * malformed body) that never reach route.ts's own streamText/onFinish
 * error handlers at all, since they throw before any of that runs.
 */
export function withApiErrorHandling<T extends (...args: any[]) => Promise<Response>>(handler: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error('[api-error]', err);
      const req = args[0] as Request | undefined;
      logError({
        source: 'api-error',
        error: err,
        context: req && 'url' in req ? { url: (req as Request).url, method: (req as Request).method } : undefined,
      });
      const message = err instanceof Error ? err.message : 'Internal server error';
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }) as T;
}
