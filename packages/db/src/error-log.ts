/**
 * Durable error logging — see schema.prisma's ErrorLog model comment for
 * the full "why" (Vercel's own log tail is too short-lived to catch a real
 * production error after the fact; this table is the queryable, permanent
 * side-channel). Deliberately fire-and-forget and never throws itself: a
 * logging call failing (DB blip, bad payload) must never take down the
 * actual request it's trying to describe.
 *
 * Usage: `logError({ source: 'direct-chat', error, userId, chatId, context })`
 * alongside (never instead of) the existing `console.error` — console
 * output is still useful for a live `vercel logs` tail during active
 * debugging, this is for everything that happens when nobody's watching.
 */
import { prisma } from './db.js';

export interface LogErrorInput {
  source: string;
  error: unknown;
  userId?: string;
  chatId?: string;
  context?: Record<string, unknown>;
}

export function logError({ source, error, userId, chatId, context }: LogErrorInput): void {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
  const stack = error instanceof Error ? error.stack : undefined;
  void prisma.errorLog
    .create({
      data: {
        source,
        message: message.slice(0, 8000),
        stack: stack?.slice(0, 8000),
        userId,
        chatId,
        context: context as any,
      },
    })
    .catch(err => {
      // Deliberately just console.error, not recursive logError -- this is
      // the one place a logging failure is allowed to be silently lossy
      // rather than risk an infinite loop or masking the original error.
      console.error('[logError] failed to persist error log', source, err);
    });
}
