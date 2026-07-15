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
 *
 * 2026-07-15: now also captures AI SDK `AI_APICallError`'s own
 * `responseBody`/`requestBodyValues`/`statusCode`/`url` fields when
 * present (folded into `context`) — confirmed real gap: a BYOK relay
 * failure's `message` alone (often a generic, unhelpful one-liner like
 * "openai_error") was NOT enough to root-cause anything after the fact;
 * only the raw response body actually shows what the provider said.
 */
import { prisma } from './db.js';

export interface LogErrorInput {
  source: string;
  error: unknown;
  userId?: string;
  chatId?: string;
  context?: Record<string, unknown>;
}

/** Best-effort duck-typed pickup of AI SDK APICallError's diagnostic fields — avoids an explicit `ai` package dependency in this package just for a type check. */
function extractApiCallErrorDetail(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;
  const hasApiCallShape = 'statusCode' in e || 'responseBody' in e || 'requestBodyValues' in e;
  if (!hasApiCallShape) return undefined;
  const detail: Record<string, unknown> = {};
  if (e.statusCode !== undefined) detail.statusCode = e.statusCode;
  if (typeof e.responseBody === 'string') detail.responseBody = e.responseBody.slice(0, 4000);
  if (e.requestBodyValues !== undefined) {
    try {
      detail.requestBodyValues = JSON.parse(JSON.stringify(e.requestBodyValues)).toString !== undefined
        ? JSON.parse(JSON.stringify(e.requestBodyValues, (key, value) => {
            // Drop full tool schemas / message history bulk — keep just
            // shape + counts, the response body above is what actually
            // explains a failure; this is only for quick eyeballing.
            if (key === 'tools' && Array.isArray(value)) return `[${value.length} tools omitted]`;
            if (key === 'messages' && Array.isArray(value)) return value.map((m: any) => ({ role: m?.role, hasToolCalls: Boolean(m?.tool_calls), contentPreview: typeof m?.content === 'string' ? m.content.slice(0, 200) : m?.content }));
            return value;
          }))
        : undefined;
    } catch {
      // best-effort only
    }
  }
  if (typeof e.url === 'string') detail.url = e.url;
  if (e.cause) detail.cause = e.cause instanceof Error ? e.cause.message : String(e.cause);
  return Object.keys(detail).length > 0 ? detail : undefined;
}

export function logError({ source, error, userId, chatId, context }: LogErrorInput): void {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const apiCallDetail = extractApiCallErrorDetail(error);
  const mergedContext = apiCallDetail ? { ...context, apiCallDetail } : context;
  void prisma.errorLog
    .create({
      data: {
        source,
        message: message.slice(0, 8000),
        stack: stack?.slice(0, 8000),
        userId,
        chatId,
        context: mergedContext as any,
      },
    })
    .catch(err => {
      // Deliberately just console.error, not recursive logError -- this is
      // the one place a logging failure is allowed to be silently lossy
      // rather than risk an infinite loop or masking the original error.
      console.error('[logError] failed to persist error log', source, err);
    });
}
