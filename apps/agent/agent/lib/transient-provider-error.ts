/**
 * Shared transient-provider-error detection + retry-with-backoff helper.
 *
 * EXTRACTED (2026-07-17) from browser_use.ts, where this logic was first
 * added to fix a real production failure ("AI_APICallError: No available
 * channel for model X under group default (distributor)") -- a genuinely
 * transient upstream capacity error, not a malformed-output problem, that
 * needs its own backoff-and-retry path instead of being surfaced as a
 * hard failure. The sub-agent delegate tool (tool-impls/agent.ts) hit the
 * exact same class of error with no retry at all, so this is now a
 * shared module both import, instead of two copies quietly drifting out
 * of sync with each other over time.
 */

export function isTransientProviderError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no available channel|503|too many requests|\b429\b|overloaded|capacity|rate.?limit|try again later|AI_RetryError|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Runs `fn`, retrying with exponential-ish backoff ONLY on errors that
 * look transient/upstream-capacity related (see isTransientProviderError).
 * Any other error is re-thrown immediately on the first attempt -- this
 * is deliberately narrow so it never masks a genuine bug (bad input,
 * auth failure, malformed response) as if retrying could ever fix it.
 */
export async function withTransientRetry<T>(fn: () => Promise<T>, opts?: { retries?: number; baseDelayMs?: number }): Promise<T> {
  const retries = opts?.retries ?? 2;
  const baseDelayMs = opts?.baseDelayMs ?? 1500;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientProviderError(err) || attempt === retries) throw err;
      await sleep(baseDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}
