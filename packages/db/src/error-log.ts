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

/**
 * Strip characters Postgres's own text/JSONB validation will reject
 * outright before we ever get to see a useful error. Confirmed live
 * (2026-07-25): a BYOK relay's raw error response body was actually
 * binary (a Cloudflare bot-challenge payload, not JSON/text at all --
 * see gateway-retry-fetch.ts), and that raw string -- lone/unpaired
 * UTF-16 surrogates, NUL bytes, other non-printable control bytes --
 * flowed straight into `responseBody` and then `context`. `JSON.stringify`
 * happily encodes lone surrogates as \uXXXX escapes, but Postgres's
 * UTF-8 validation on the way into a text/jsonb column rejects those same
 * escapes as invalid ("unsupported Unicode escape sequence", code
 * 22P05) -- so the create() call itself threw, and the ONE place that's
 * supposed to durably capture "what actually happened" instead silently
 * lost the error entirely (see the catch below -- by design it doesn't
 * retry or rethrow, so this failure mode was invisible without a live
 * log tail at the exact moment it happened). Replacing anything that
 * isn't valid, storable text with a placeholder means logError can never
 * itself be the reason an error goes unrecorded, regardless of how
 * garbled the thing it's describing is.
 */
function sanitizeForStorage(value: string): string {
  // Drop lone (unpaired) surrogates -- valid in a JS string, not valid
  // UTF-8/UTF-16 text once serialized. A valid pair is [\uD800-\uDBFF]
  // immediately followed by [\uDC00-\uDFFF]; anything else is lone.
  const noLoneSurrogates = value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD'
  );
  // Drop NUL and other C0 control bytes Postgres text also rejects,
  // keeping common whitespace (tab/newline/CR).
  return noLoneSurrogates.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '\uFFFD');
}

/** Recursively sanitize every string value in an arbitrary JSON-ish
 *  structure (the `context` payload) so nothing buried inside it -- a
 *  responseBody two levels deep in apiCallDetail, etc. -- can trip the
 *  same Postgres rejection. */
function sanitizeContextDeep(value: unknown, depth = 0): unknown {
  if (depth > 10) return value; // guard against pathological nesting
  if (typeof value === 'string') return sanitizeForStorage(value);
  if (Array.isArray(value)) return value.map(v => sanitizeContextDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeContextDeep(v, depth + 1);
    return out;
  }
  return value;
}


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
        message: sanitizeForStorage(message.slice(0, 8000)),
        stack: stack ? sanitizeForStorage(stack.slice(0, 8000)) : undefined,
        userId,
        chatId,
        context: sanitizeContextDeep(mergedContext) as any,
      },
    })
    .catch(err => {
      // Deliberately just console.error, not recursive logError -- this is
      // the one place a logging failure is allowed to be silently lossy
      // rather than risk an infinite loop or masking the original error.
      console.error('[logError] failed to persist error log', source, err);
    });
}
