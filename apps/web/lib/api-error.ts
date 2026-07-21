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
 *
 * ENRICHED (2026-07-21, "analyze the whole BYOK system ... log everything
 * so we can easily catch errors" -- full audit of every BYOK route):
 * every BYOK route is dynamic (`/providers/[providerId]/...`), and
 * knowing WHICH provider/model a 500 happened for used to require
 * re-deriving it from the request URL by hand every time someone read
 * error_logs. Next.js route handlers always get `(req, { params })` as
 * their second arg -- that `params` promise is cheap and safe to read
 * here too (Next resolves it once per request regardless of how many
 * times it's awaited), so every dynamic-route error log now carries the
 * actual route params (providerId, modelId, ...) automatically, with zero
 * extra DB/network cost and no per-route changes required.
 */
export function withApiErrorHandling<T extends (...args: any[]) => Promise<Response>>(handler: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await handler(...args);
    } catch (err) {
      const req = args[0] as Request | undefined;
      const routeCtx = args[1] as { params?: Promise<Record<string, string>> } | undefined;

      let routeParams: Record<string, string> | undefined;
      if (routeCtx?.params) {
        try {
          routeParams = await routeCtx.params;
        } catch {
          // params resolution itself failing is not worth losing the
          // original error over -- just omit it from context.
        }
      }

      console.error('[api-error]', req?.url, routeParams, err);
      logError({
        source: 'api-error',
        error: err,
        context: {
          ...(req && 'url' in req ? { url: (req as Request).url, method: (req as Request).method } : undefined),
          ...(routeParams ? { routeParams } : undefined),
        },
      });
      const message = err instanceof Error ? err.message : 'Internal server error';
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }) as T;
}
