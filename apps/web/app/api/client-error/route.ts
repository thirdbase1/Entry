import { NextRequest, NextResponse } from 'next/server';
import { logError } from '@entry/db/error-log';
import { getUserSessionFromRequest } from '@entry/auth';

/**
 * Sink for ErrorBoundary reports (components/error-boundary.tsx). Fire-
 * and-forget from the client -- best-effort only, never throws back at
 * the caller (a logging failure must never compound a UI crash). This is
 * what turns "a button silently did nothing" into a real, searchable
 * server-side log entry with the user, URL, and stack attached, instead
 * of a client-side crash nobody ever finds out about.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    let userId: string | undefined;
    try {
      const { session } = await getUserSessionFromRequest(req);
      userId = session?.user?.id;
    } catch {
      // unauthenticated errors (e.g. sign-in page itself crashing) are still worth logging
    }
    logError({
      source: 'client-error-boundary',
      error: new Error(typeof body?.message === 'string' ? body.message : 'Unknown client error'),
      userId,
      context: {
        region: body?.region,
        url: body?.url,
        stack: typeof body?.stack === 'string' ? body.stack.slice(0, 4000) : undefined,
        componentStack: typeof body?.componentStack === 'string' ? body.componentStack.slice(0, 4000) : undefined,
      },
    });
  } catch (err) {
    console.error('[client-error] failed to log', err);
  }
  return NextResponse.json({ ok: true });
}
