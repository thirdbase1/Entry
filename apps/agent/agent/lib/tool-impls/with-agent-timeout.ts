import { z } from 'zod';
import { withTimeoutSignal } from './with-timeout-signal.js';

/**
 * Default tool-call ceiling: 10 minutes (2026-07-20, "bump the limit of
 * everything up to 10 minutes by default" for the standalone Pxxl/Render
 * worker). The old low per-tool ceilings across this directory (bash's
 * 240s, python_coding/task_analysis/code_artifact's 75s, agent's 280s
 * cap) all existed specifically to leave headroom under Vercel Hobby's
 * serverless maxDuration (300s) -- see bash.ts's own 2026-07-18 history
 * comment. The worker is a persistent long-lived process, not a
 * serverless function -- there is no outer 300s ceiling forcing tool
 * timeouts to stay artificially short here, so the default moves to a
 * much more generous 10 minutes.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60 * 1000;

/** Model-facing cap on the override itself -- generous, but not unbounded. */
const MAX_TIMEOUT_SECONDS = 3600; // 1 hour

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
      .max(MAX_TIMEOUT_SECONDS)
      .optional()
      .describe(
        `Optional override for how long this call is allowed to run, in seconds. Defaults to ${Math.round(defaultMs / 1000)}s ` +
          `(${Math.round(defaultMs / 60000)} min) if omitted. Raise it for a genuinely long-running call; lower it to fail fast instead of waiting.`
      ),
  });

  const rawExecute = impl.execute;

  const wrappedExecute = async (input: any, ctx?: any) => {
    const { timeout_seconds, ...rest } = input ?? {};
    const timeoutMs = typeof timeout_seconds === 'number' && timeout_seconds > 0 ? timeout_seconds * 1000 : defaultMs;
    const t = withTimeoutSignal(ctx?.abortSignal, timeoutMs, toolName);
    const shadowCtx = ctx ? { ...ctx, abortSignal: t.signal } : ctx;
    try {
      return await Promise.race([
        rawExecute(rest, shadowCtx),
        new Promise<never>((_, reject) => {
          t.signal.addEventListener('abort', () => reject(t.signal.reason ?? new Error(`${toolName} timed out after ${timeoutMs / 1000}s`)), {
            once: true,
          });
        }),
      ]);
    } catch (err) {
      throw t.rethrow(err);
    } finally {
      t.clear();
    }
  };

  return { ...impl, inputSchema: extendedSchema, execute: wrappedExecute } as T;
}
