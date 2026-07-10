/**
 * Wraps a tool's `execute` so a thrown error (missing/invalid API key,
 * upstream 4xx/5xx, network failure, etc.) turns into a plain `{ error }`
 * result instead of an uncaught rejection.
 *
 * Why this matters: an unhandled throw from inside a streamText/generateText
 * tool call does not cleanly resolve to a tool-error part the model can see
 * and explain — it can tear down the whole in-flight stream, which is
 * exactly what a user watching the chat perceives as "it just stops,
 * instantly" the moment a tool like web_search fires. Confirmed root cause
 * in production (2026-07-10): PARALLEL_API_KEY was set to an empty string,
 * so `web_search`'s `getClient()` threw synchronously on every single call.
 * That specific env var is fixed, but nothing stopped it (or any other
 * tool's own upstream) from doing the exact same thing again — this
 * wrapper is the actual fix so a bad key/outage/quota error surfaces as a
 * normal, recoverable tool result instead of killing the turn.
 *
 * Applied at the source (lib/tool-impls/*.ts) rather than at each
 * registration site, so every consumer — eve's own root-agent tools/*.ts
 * wrappers AND apps/web's direct-model chat route — gets it automatically,
 * with one fix point instead of N.
 */
export function safeExecute<TInput, TOutput>(
  toolName: string,
  execute: (input: TInput, ctx?: any) => Promise<TOutput>
): (input: TInput, ctx?: any) => Promise<TOutput | { error: string }> {
  return async (input: TInput, ctx?: any) => {
    try {
      return await execute(input, ctx);
    } catch (err) {
      return {
        error: `${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}
