/**
 * Durable wrapper around a single E2B sandbox command, used by
 * getSandboxForChat's run() (see ./sandbox.ts).
 *
 * WHY THIS EXISTS (2026-08-07): the app moved (back) onto Vercel serverless
 * (see DEPLOY.md) after an earlier pass had deliberately moved OFF it onto
 * a persistent worker specifically to dodge Vercel's per-invocation
 * duration ceiling (see lib/tool-impls/bash.ts's TIMEOUT_MS comment history
 * for that full incident). Being back on Vercel reintroduces that risk: a
 * single long-running sandbox command (npm install, a real build, a
 * clone+audit+build pipeline run as one call) used to just ride the
 * calling function's own lifetime -- if that function got killed by a
 * redeploy or a platform-level ceiling mid-call, the result was lost
 * outright with nothing surfaced to the model or the user.
 *
 * Fix: the actual E2B call is isolated as its own durable `'use step'`,
 * invoked from a `'use workflow'` orchestrator. Steps are tracked/resumed
 * independently of the calling request's lifetime (Vercel Fluid Compute
 * suspends the caller cheaply while a step runs elsewhere) -- the caller
 * just awaits `run.returnValue`, which polls the durable run rather than
 * holding one live connection open for the command's whole duration. This
 * is deliberately a single-step workflow -- the durability win here is
 * entirely "decouple the command's execution lifetime from the calling
 * request's lifetime", not multi-step orchestration.
 *
 * E2BSandbox instances aren't serializable across a step boundary (workflow
 * inputs/outputs are recorded in a durable event log), so the step
 * reconnects by `sandboxId` instead of receiving a live sandbox object --
 * same reconnect-by-id pattern getSandboxForChat itself already uses in
 * sandbox.ts. The E2B API key is deliberately NOT passed as a workflow/step
 * argument (that would put a secret into the durable log) -- it's read
 * straight from `process.env.E2B_API_KEY` inside the step instead, exactly
 * like sandbox.ts's own resolveApiKey().
 */
import { Sandbox as E2BSandbox, RateLimitError as E2BRateLimitError } from 'e2b';

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function resolveApiKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) {
    throw new Error('E2B_API_KEY is not configured — sandbox commands are unavailable until it is set.');
  }
  return key;
}

// Kept in sync with sandbox.ts's own retry policy -- duplicated rather than
// imported for the same reason sandbox.ts's copy is duplicated from
// apps/agent/agent/sandbox/e2b-backend.ts's: no shared "sandbox internals"
// package exists between these, and the policy should never differ anyway.
const RETRY_MAX_ATTEMPTS = 10;
const RETRY_BASE_DELAY_MS = 300;
const RETRY_MAX_DELAY_MS = 8_000;

function isRetryableE2BError(err: unknown): boolean {
  if (err instanceof E2BRateLimitError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate.?limit|\b50[0-4]\b|ECONNRESET|ETIMEDOUT|network error/i.test(message);
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableE2BError(err) || attempt === RETRY_MAX_ATTEMPTS) throw err;
      const uncappedDelay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
      const delay = Math.min(uncappedDelay, RETRY_MAX_DELAY_MS);
      console.warn(
        `[direct-chat/sandbox-workflow] ${label} hit a retryable error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying in ${Math.round(delay)}ms:`,
        err instanceof Error ? err.message : err,
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * The actual E2B call, isolated as its own durable step -- runs as its own
 * isolated request while the calling workflow suspends without consuming
 * resources. `timeoutMs` is enforced here via a fresh AbortController
 * (rather than accepting the caller's own AbortSignal, which can't cross
 * the step boundary) -- this mirrors the original inline implementation's
 * hard safety-net ceiling.
 */
async function execSandboxCommandStep(
  sandboxId: string,
  command: string,
  env: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<SandboxCommandResult> {
  'use step';
  const apiKey = resolveApiKey();
  const sandbox = await withRetry('Sandbox.connect (workflow step)', () => E2BSandbox.connect(sandboxId, { apiKey }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await withRetry('commands.run (workflow step)', () =>
      sandbox.commands.run(command, { timeoutMs: 60 * 60 * 1000, envs: env, signal: controller.signal }),
    );
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Workflow orchestrator -- deliberately a single step, see file comment.
 */
export async function runSandboxCommandWorkflow(
  sandboxId: string,
  command: string,
  env: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<SandboxCommandResult> {
  'use workflow';
  return execSandboxCommandStep(sandboxId, command, env, timeoutMs);
}
