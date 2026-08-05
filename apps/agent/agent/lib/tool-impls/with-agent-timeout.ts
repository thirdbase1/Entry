import { z } from 'zod';
import { withTimeoutSignal } from './with-timeout-signal.js';

/**
 * Tool timeout policy: no implicit wall-clock ceiling. A tool may be
 * explicitly bounded with `timeout_seconds` when the caller wants that;
 * otherwise it inherits only the parent turn's cancellation signal.
 *
 * Default tool-call ceiling history: 20 minutes (raised 2026-07-25, real
 * user-reported bug: long BYOK turns doing genuine sustained work --
 * builds, installs, browser sessions -- kept getting cut off, and the
 * model had no reason to know it needed to pass a larger
 * `timeout_seconds` up front for an ordinary-looking call). Previously
 * 10 minutes (2026-07-20, "bump the limit of everything up to 10 minutes
 * by default" for the standalone Pxxl/Render worker) -- the old low
 * per-tool ceilings across this directory (bash's 240s, python_coding/
 * task_analysis/code_artifact's 75s, agent's 280s cap) all existed
 * specifically to leave headroom under Vercel Hobby's serverless
 * maxDuration (300s) -- see bash.ts's own 2026-07-18 history comment.
 * The worker is a persistent long-lived process, not a serverless
 * function -- there is no outer 300s (or 600s) ceiling forcing tool
 * timeouts to stay artificially short here. 10 minutes was still just an
 * arbitrary leftover number once that constraint was gone, and real
 * tool calls (a slow npm install, a multi-page browser_use session, a
 * large sandbox build) routinely run past it with no way for the model
 * to have known to override `timeout_seconds` in advance for what looked
 * like an ordinary call. The model can still always request up to
 * MAX_TIMEOUT_SECONDS (1 hour) explicitly for a call it knows will be
 * genuinely long-running.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 0; // 0 means no implicit timeout

/** Model-facing cap on the override itself -- generous, but not unbounded. */

type ToolImpl = {
  description: string;
  inputSchema: z.ZodObject<any>;
  execute: (input: any, ctx?: any) => Promise<any>;
};

/**
 * Applies a uniform, model-overridable timeout to any tool-impl object
 * (the `{ description, inputSchema, execute }` shape every file in this
 * directory exports). Call this LAST, after `safeExecute` has already
 * wrapped `execute` -- see this directory's existing
 * `X.execute = safeExecute('x', X.execute)` tail line pattern -- so a
 * timeout still resolves to a clean `{ error }` result via
 * `withTimeoutSignal`'s rethrow, same as any other tool failure, instead
 * of an uncaught rejection.
 *
 * Adds an optional `timeout_seconds` field to the tool's own inputSchema
 * so the model can request a longer or shorter ceiling per call --
 * raise it for a genuinely long-running call (a big install, a long
 * crawl, a multi-file refactor), lower it to fail fast instead of
 * waiting out the full default.
 *
 * Uses a real `Promise.race` (not just an abort signal) so the call
 * reliably returns to the model within the requested budget even for
 * tools whose own `execute` doesn't read `ctx.abortSignal` at all --
 * most of the 18 tools this is first applied to (2026-07-20) never had
 * any timeout wiring before this. Tools that DO read `ctx.abortSignal`
 * (sandbox commands, generateText/generateObject calls) still get real
 * cancellation too, via the combined signal handed to a shadow ctx --
 * best of both: cooperating tools cancel their actual work; every tool,
 * cooperating or not, still returns on time.
 */
export function withAgentTimeout<T extends ToolImpl>(toolName: string, impl: T, defaultMs: number = DEFAULT_TOOL_TIMEOUT_MS): T {
  const extendedSchema = impl.inputSchema.extend({
    timeout_seconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Optional explicit wall-clock timeout in seconds. If omitted, this tool is not locally timed out and runs until it finishes or the parent turn is cancelled.'
      ),
  });

  const rawExecute = impl.execute;

  const wrappedExecute = async (input: any, ctx?: any) => {
    const { timeout_seconds, ...rest } = input ?? {};
    const timeoutMs = typeof timeout_seconds === 'number' && timeout_seconds > 0
      ? timeout_seconds * 1000
      : defaultMs > 0
        ? defaultMs
        : undefined;
    const t = timeoutMs === undefined ? null : withTimeoutSignal(ctx?.abortSignal, timeoutMs, toolName);
    const shadowCtx = ctx ? { ...ctx, ...(t ? { abortSignal: t.signal } : {}) } : ctx;
    try {
      if (!t) return await rawExecute(rest, shadowCtx);
      return await Promise.race([
        rawExecute(rest, shadowCtx),
        new Promise<never>((_, reject) => {
          t.signal.addEventListener('abort', () => reject(t.signal.reason ?? new Error(`${toolName} timed out after ${(timeoutMs ?? 0) / 1000}s`)), {
            once: true,
          });
        }),
      ]);
    } catch (err) {
      throw t ? t.rethrow(err) : err;
    } finally {
      t?.clear();
    }
  };

  return { ...impl, inputSchema: extendedSchema, execute: wrappedExecute } as T;
}
