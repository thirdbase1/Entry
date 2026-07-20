/**
 * Custom eve SandboxBackend backed by E2B (github.com/e2b-dev/e2b, Apache-2.0)
 * instead of Vercel Sandbox.
 *
 * WHY THIS EXISTS: production hit Vercel Sandbox's Hobby-plan usage cap
 * (402 payment_required, resets 2026-08-01). eve's own `SandboxBackend`
 * interface is explicitly public for authors to implement their own
 * (confirmed in node_modules/eve/dist/src/shared/sandbox-backend.d.ts),
 * so this replaces `vercel()` with an equivalent built on E2B's hosted
 * sandboxes — reachable over plain HTTPS from a Vercel serverless
 * function (no local Docker daemon / KVM needed, unlike docker() or
 * microsandbox(), which is why those two backends can't run here at all:
 * see eve/docs/sandbox.mdx's "defaultBackend()" priority list). E2B has
 * an Apache-2.0 core, a free Hobby tier ($100 starting credit, no card),
 * and ~$0.05/hr per sandbox after that.
 *
 * TEMPLATE STRATEGY: eve's `prewarm()` hands us an arbitrary authored
 * `bootstrap` callback to capture ONCE into a reusable template; `create()`
 * then has to spin up NEW independent sessions from that captured state,
 * potentially many, potentially concurrently. E2B's primitive for exactly
 * this is `sandbox.createSnapshot()` — "one-to-many: a single snapshot can
 * be used to create many new sandboxes" (confirmed via e2b.dev/docs/sandbox/
 * snapshots) — as opposed to E2B's *Templates* feature, which is a
 * declarative Dockerfile-build system that doesn't have anywhere to plug
 * in an arbitrary JS bootstrap function. So: prewarm() creates a base
 * sandbox, runs the given `bootstrap` against it, snapshots it, and
 * persists the resulting `snapshotId` in Postgres (see
 * packages/db SandboxTemplate model) keyed by `templateKey` — `prewarm()`
 * runs in the Vercel BUILD container and `create()` runs later inside the
 * deployed function, different processes entirely, so the snapshot id has
 * to be persisted somewhere both sides can reach.
 */
import { Sandbox as E2BSandbox, RateLimitError as E2BRateLimitError } from 'e2b';
import { defineSandbox } from 'eve/sandbox';
import type {
  SandboxBackend,
  SandboxBackendCreateInput,
  SandboxBackendHandle,
  SandboxBackendPrewarmInput,
} from 'eve/sandbox';

/** Not exported from eve/sandbox's public entry point; shape confirmed against
 * eve/dist/src/shared/sandbox-backend.d.ts (`{ readonly reused: boolean }`). */
type SandboxBackendPrewarmResult = { readonly reused: boolean };
import { prisma } from '@entry/db';
import { restoreLatestFilesToSandbox } from '@entry/db/chat-versioning';

export interface E2BBackendOptions {
  /** Falls back to process.env.E2B_API_KEY. */
  readonly apiKey?: string;
  /** Idle timeout before E2B auto-pauses an unused sandbox. Default 5 minutes. */
  readonly timeoutMs?: number;
}

const BACKEND_NAME = 'e2b';

/**
 * Custom E2B base template (2 vCPU / 2GB RAM, no extra software baked
 * in -- see build script this was produced with) used instead of E2B's
 * default 'base' template (~480MB, confirmed too small for headless
 * Chrome's renderer process). Every sandbox this backend creates,
 * bootstrapped or not, starts from this so the compute envelope is
 * always sufficient once `sandbox.ts`'s bootstrap installs Chrome.
 */
const BASE_TEMPLATE = process.env.E2B_BASE_TEMPLATE ?? 'entry-agent-base';

/**
 * FIXED (2026-07-18, real user-reported bug: "sandbox is clearing my work").
 * Root cause: every `E2BSandbox.create()` call in this file left E2B's
 * `lifecycle.onTimeout` at its SDK default of `'kill'` (confirmed in
 * node_modules/e2b/dist/index.d.ts's `SandboxLifecycle` -- `@default "kill"`).
 * That means every sandbox that went idle past its timeout was HARD DELETED,
 * filesystem and all -- not paused. The only thing standing between a user
 * and total data loss was `restoreLatestFilesToSandbox` (chat-versioning.ts),
 * which only replays whatever was captured at the last explicit checkpoint
 * (not a live, exact snapshot), and whose own restore call here is wrapped in
 * `.catch(() => {})` -- so a failed restore silently left the user with an
 * empty sandbox and zero error surfaced anywhere. That combination is exactly
 * "my work got cleared" with no warning.
 *
 * E2B's actual fix for this is a first-class feature we simply weren't using:
 * `lifecycle: { onTimeout: 'pause', autoResume: true }`. On timeout this
 * takes a full memory+filesystem snapshot and pauses (rather than kills) the
 * sandbox; per E2B's own docs this snapshot is "a persistent image that
 * survives sandbox deletion" (not a short-lived TTL'd thing like the old
 * kill-timeout was). `Sandbox.connect(sandboxId)` -- already what `create()`
 * below calls for an existing session -- transparently auto-resumes a paused
 * sandbox with its exact prior state (confirmed in the SDK's own doc comment:
 * "Connect to a sandbox. If the sandbox is paused, it will be automatically
 * resumed."). `autoResume: true` additionally lets direct inbound traffic
 * (e.g. a live preview URL opened via cloudflared, see get_preview_url.ts)
 * wake a paused sandbox on its own, without going through our `create()` path
 * at all. Net effect: idle sandboxes now round-trip through a real, complete
 * snapshot/resume cycle instead of a lossy custom DB-based file replay --
 * `restoreLatestFilesToSandbox` stays in place purely as a last-resort for
 * the rare case E2B can no longer resume a given sandbox at all (e.g. past
 * its account-level retention), not as the routine recovery path it was
 * before this fix.
 */
const SANDBOX_LIFECYCLE = { onTimeout: 'pause' as const, autoResume: true };

function resolveApiKey(options: E2BBackendOptions | undefined): string {
  const key = options?.apiKey ?? process.env.E2B_API_KEY;
  if (!key) {
    throw new Error(
      'e2b() sandbox backend requires an E2B_API_KEY (set it as a Vercel env var, or pass { apiKey } explicitly). ' +
        'Sign up free at https://e2b.dev — no credit card required, $100 starting credit.',
    );
  }
  return key;
}

/**
 * Confirmed real bug (2026-07-15, user-reported + reproduced live):
 * "bash failed: Status code 429 is not ok" repeated 3x in a row on the
 * SAME session before recovering on its own a few seconds later. There
 * was zero retry logic anywhere in this file -- every E2B API call
 * (sandbox create/connect, every command run, every file op) was a bare
 * single attempt, so a transient 429 from E2B's own API rate limiter
 * (documented at e2b.dev/docs -- applies per-API-key across concurrent
 * sandbox creation + command execution) surfaced immediately as a hard
 * tool failure instead of being absorbed. E2B's SDK exposes a dedicated
 * `RateLimitError` class for exactly this (confirmed in
 * node_modules/e2b/dist/index.d.ts), so retry specifically on that
 * (plus generic transient 5xx/network errors -- NOT on real errors like
 * bad commands or missing files, which should keep failing fast).
 * Exponential backoff with jitter, capped attempts, so a sustained outage
 * still surfaces an error rather than hanging the tool call forever.
 */
// UPDATED (2026-07-16, real bug: "429 in tool calls should never happen
// at all") — 4 attempts with an uncapped exponential backoff only bought
// ~3.5s of total absorption (500ms + 1s + 2s, then give up on attempt 4).
// That's short enough that any 429 burst lasting more than a few seconds
// (E2B's own per-API-key limiter, documented as applying across
// concurrent sandbox creation + command execution) still surfaced as a
// hard tool failure -- exactly the reported symptom. Raised to 10
// attempts with the backoff CAPPED at 8s per wait (rather than left to
// grow unbounded past useful) so total worst-case absorption is ~50s of
// patient retrying before a 429 is ever allowed to reach the caller as a
// real error, while still comfortably fitting inside a single tool call's
// budget (well under the 75s sub-generation timeout / 300s route
// maxDuration) instead of hanging indefinitely.
const RETRY_MAX_ATTEMPTS = 10;
const RETRY_BASE_DELAY_MS = 500;
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
      console.warn(`[e2b] ${label} hit a retryable error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying in ${Math.round(delay)}ms:`, err instanceof Error ? err.message : err);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/** Anchors a sandbox-relative path to /workspace, mirroring every other backend. */
function resolvePath(path: string): string {
  if (path.startsWith('/')) return path;
  return `/workspace/${path}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function toReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Builds the subset of eve's SandboxSession this backend must implement
 * (`run`, `spawn`, `readFile`, `readBinaryFile`, `readTextFile`,
 * `writeFile`, `writeBinaryFile`, `writeTextFile`) directly against one
 * live E2B sandbox instance.
 */
function buildSession(sandbox: E2BSandbox, refreshTimeoutMs: number) {
  // FIXED (2026-07-16, real bug confirmed live via E2B's own API: exactly
  // 20/20 concurrent sandboxes stuck "running" -- E2B's hard account cap
  // -- blocking every new sandbox creation for every user). Root cause:
  // `timeoutMs` passed to `E2BSandbox.create`/`.connect` is a ONE-SHOT
  // wall-clock TTL from creation time (confirmed in e2b's own
  // `sandbox.setTimeout` doc comment: "can extend or reduce the sandbox
  // timeout set when creating the sandbox or from the last call to
  // .setTimeout" -- i.e. it is NEVER extended on its own). This backend
  // deliberately reuses the SAME sandbox across an entire chat session
  // (existingSandboxId) so bash/browser_use share state -- but nothing
  // ever refreshed that TTL, so any session older than the original
  // window (5 min default) got hard-killed by E2B mid-task regardless of
  // whether it was actively in use. That mid-task kill is exactly what
  // surfaced as "browser tool still failing", "agent timing out waiting
  // on a tool call", AND browser_use's screenshot silently not
  // rendering (takeScreenshot()'s own try/catch swallows the resulting
  // command failure into a null screenshotUrl with no visible error at
  // all). Refreshing the timeout on every real command keeps genuinely
  // active sessions alive indefinitely while still letting truly
  // abandoned ones expire and free their concurrency slot shortly after
  // the last real activity, same as any normal session/idle-timeout.
  function refreshTimeout() {
    void sandbox.setTimeout(refreshTimeoutMs).catch(() => {
      /* best-effort keep-alive -- a failed refresh shouldn't fail the command itself */
    });
  }
  return {
    async run(opts: { command: string; workingDirectory?: string; env?: Record<string, string>; abortSignal?: AbortSignal }) {
      refreshTimeout();
      const result = await withRetry('commands.run', () =>
        sandbox.commands.run(opts.command, {
          cwd: opts.workingDirectory ?? '/workspace',
          envs: opts.env,
          // E2B's default per-command timeout is short; sandbox bootstrap
          // steps (apt-get, npm install -g) legitimately take minutes.
          timeoutMs: 15 * 60 * 1000,
        }),
      );
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },

    async spawn(opts: { command: string; workingDirectory?: string; env?: Record<string, string>; abortSignal?: AbortSignal }) {
      refreshTimeout();
      let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
      let stderrController!: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({
        start(c) {
          stdoutController = c;
        },
      });
      const stderr = new ReadableStream<Uint8Array>({
        start(c) {
          stderrController = c;
        },
      });
      const encoder = new TextEncoder();

      const handle = await withRetry('commands.run (background)', () => sandbox.commands.run(opts.command, {
        cwd: opts.workingDirectory ?? '/workspace',
        envs: opts.env,
        background: true,
        onStdout: (data: string) => {
          try {
            stdoutController.enqueue(encoder.encode(data));
          } catch {
            /* stream already closed */
          }
        },
        onStderr: (data: string) => {
          try {
            stderrController.enqueue(encoder.encode(data));
          } catch {
            /* stream already closed */
          }
        },
      }));

      opts.abortSignal?.addEventListener('abort', () => {
        void handle.kill();
      });

      return {
        pid: undefined,
        stdout,
        stderr,
        async wait() {
          const result = await handle.wait();
          try {
            stdoutController.close();
          } catch {
            /* already closed */
          }
          try {
            stderrController.close();
          } catch {
            /* already closed */
          }
          return { exitCode: result.exitCode };
        },
        async kill() {
          await handle.kill();
        },
      };
    },

    async readFile(opts: { path: string; abortSignal?: AbortSignal }) {
      const path = resolvePath(opts.path);
      try {
        const bytes = await withRetry('files.read', () => sandbox.files.read(path, { format: 'bytes' }));
        return toReadableStream(bytes as Uint8Array);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async readBinaryFile(opts: { path: string; abortSignal?: AbortSignal }) {
      const path = resolvePath(opts.path);
      try {
        const bytes = await withRetry('files.read', () => sandbox.files.read(path, { format: 'bytes' }));
        return bytes as Uint8Array;
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async readTextFile(opts: { path: string; encoding?: string; startLine?: number; endLine?: number; abortSignal?: AbortSignal }) {
      const path = resolvePath(opts.path);
      let text: string;
      try {
        text = await withRetry('files.read', () => sandbox.files.read(path, { format: 'text' }));
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      if (opts.startLine === undefined && opts.endLine === undefined) return text;
      const lines = text.split('\n');
      const start = Math.max(1, opts.startLine ?? 1);
      const end = Math.min(lines.length, opts.endLine ?? lines.length);
      return lines.slice(start - 1, end).join('\n');
    },

    async writeFile(opts: { path: string; content: ReadableStream<Uint8Array>; abortSignal?: AbortSignal }) {
      const bytes = await collectStream(opts.content);
      await withRetry('files.write', () => sandbox.files.write(resolvePath(opts.path), toArrayBuffer(bytes)));
    },

    async writeBinaryFile(opts: { path: string; content: Uint8Array; abortSignal?: AbortSignal }) {
      await withRetry('files.write', () => sandbox.files.write(resolvePath(opts.path), toArrayBuffer(opts.content)));
    },

    async writeTextFile(opts: { path: string; content: string; encoding?: string; abortSignal?: AbortSignal }) {
      await withRetry('files.write', () => sandbox.files.write(resolvePath(opts.path), opts.content));
    },
  };
}

function isNotFound(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not found|no such file|404/i.test(message);
}

/**
 * The custom E2B-backed SandboxBackend. Use in place of `vercel()` in
 * `agent/sandbox/sandbox.ts`.
 */
export function e2b(options: E2BBackendOptions = {}): SandboxBackend {
  return {
    name: BACKEND_NAME,

    async prewarm(input: SandboxBackendPrewarmInput): Promise<SandboxBackendPrewarmResult> {
      const apiKey = resolveApiKey(options);
      const existing = await prisma.sandboxTemplate.findUnique({ where: { templateKey: input.templateKey } });
      if (existing) {
        input.log?.(`[e2b] reusing existing snapshot for template "${input.templateKey}": ${existing.snapshotId}`);
        return { reused: true };
      }

      input.log?.(`[e2b] no cached snapshot for template "${input.templateKey}" — building fresh`);
      // FIXED (2026-07-15, confirmed live): E2B's default 'base' template
      // gives ~480MB RAM -- not enough headroom for Chrome's renderer
      // process (reproduced the exact failure: V8 "OOM (Failed to reserve
      // virtual memory for CodeRange)", then CDP's Page.enable hanging
      // forever). Built a custom base template (`entry-agent-base`, 2
      // vCPU / 2GB, e2b.dev Template.build) with nothing else baked in --
      // snapshots taken from a sandbox inherit its parent's compute
      // envelope, so starting bootstrap from this instead of the bare
      // default template is what actually fixes it for every session
      // cloned from the resulting snapshot.
      const sandbox = await withRetry('Sandbox.create', () => E2BSandbox.create(BASE_TEMPLATE, { apiKey, timeoutMs: options.timeoutMs ?? 5 * 60 * 1000, lifecycle: SANDBOX_LIFECYCLE }));
      try {
        // FIXED (2026-07-20): the `entry-agent-base` template's actual root fs has no
        // /workspace dir baked in (confirmed live via E2B API: only /code and /home/user
        // exist out of the box). `resolvePath()` / every default `cwd` in this file assume
        // /workspace exists, but that was previously only true by accident -- whenever
        // `input.seedFiles` was non-empty, `sandbox.files.write()`'s implicit `mkdir -p`
        // on the parent path created it as a side effect before `bootstrap()` ran. If a
        // caller ever prewarms with zero seed files, the very first bootstrap command
        // (cwd defaulting to /workspace) hard-fails with
        // "[invalid_argument] cwd '/workspace' does not exist" before anything else runs.
        // Explicitly ensuring the dir exists up front removes that ordering dependency
        // entirely, for every future template/config combination, not just this one.
        await withRetry('mkdir /workspace', () => sandbox.commands.run('sudo mkdir -p /workspace && sudo chown "$(whoami)":"$(whoami)" /workspace', { cwd: '/' }));
        for (const seed of input.seedFiles) {
          const data = typeof seed.content === 'string' ? seed.content : toArrayBuffer(seed.content);
          await withRetry('files.write (seed)', () => sandbox.files.write(resolvePath(seed.path), data));
        }
        if (input.bootstrap) {
          const session = buildSession(sandbox, options.timeoutMs ?? 5 * 60 * 1000);
          await input.bootstrap({ use: async () => session as never });
        }
        const snapshot = await withRetry('createSnapshot', () => sandbox.createSnapshot());
        await prisma.sandboxTemplate.upsert({
          where: { templateKey: input.templateKey },
          create: { templateKey: input.templateKey, snapshotId: snapshot.snapshotId },
          update: { snapshotId: snapshot.snapshotId },
        });
        input.log?.(`[e2b] captured snapshot ${snapshot.snapshotId} for template "${input.templateKey}"`);
        return { reused: false };
      } finally {
        // The base sandbox used to build the snapshot isn't needed once
        // captured — every real session spawns its own fresh instance
        // from the snapshot.
        await sandbox.kill().catch(() => {});
      }
    },

    async create(input: SandboxBackendCreateInput): Promise<SandboxBackendHandle> {
      const apiKey = resolveApiKey(options);
      const existingSandboxId = (input.existingMetadata?.sandboxId as string | undefined) ?? undefined;

      let sandbox: E2BSandbox;
      let restoredFromEviction = false;
      if (existingSandboxId) {
        try {
          sandbox = await withRetry('Sandbox.connect', () => E2BSandbox.connect(existingSandboxId, { apiKey }));
        } catch (err) {
          // With SANDBOX_LIFECYCLE (`onTimeout: 'pause'`) in place, `connect()`
          // should transparently resume a paused sandbox almost always -- this
          // branch firing now means genuine, harder loss (E2B-side retention
          // expiry, account issue, etc.), not routine idle recycling. Log it
          // loudly rather than silently falling back, so this stays visible
          // (previously this exact path was the ROUTINE case for every idle
          // sandbox, so it deliberately wasn't noisy -- that's no longer true).
          console.warn(
            `[e2b] Sandbox.connect(${existingSandboxId}) failed, sandbox could not be resumed -- ` +
              `falling back to a fresh sandbox + best-effort file restore from the last checkpoint:`,
            err instanceof Error ? err.message : err,
          );
          sandbox = await createFromTemplate(input, apiKey, options);
          restoredFromEviction = true;
        }
      } else {
        sandbox = await createFromTemplate(input, apiKey, options);
      }

      // Last-resort fallback only (see SANDBOX_LIFECYCLE comment above) --
      // replays whatever was captured at the last chat-versioning checkpoint,
      // which is NOT necessarily every file/edit since then. `tags.sessionId`
      // is the real chat/session id (confirmed against eve's own
      // context/providers/sandbox.js -- same value ctx.session.id resolves to
      // everywhere else), always set regardless of which branch above ran.
      const chatIdForRestore = input.tags?.sessionId;
      if (restoredFromEviction && chatIdForRestore) {
        await restoreLatestFilesToSandbox(chatIdForRestore, {
          run: async ({ command }) => {
            const r = await sandbox.commands.run(command, { timeoutMs: 60_000 });
            return { exitCode: r.exitCode ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
          },
        }).catch(err => {
          // FIXED (2026-07-18): this used to be a bare `.catch(() => {})` --
          // if the restore itself failed, the user was left with a genuinely
          // empty sandbox and there was no trace anywhere that anything had
          // gone wrong. Now at least surfaces in logs for real investigation.
          console.error(`[e2b] restoreLatestFilesToSandbox failed for chat ${chatIdForRestore}:`, err instanceof Error ? err.message : err);
        });
      }

      const refreshTimeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
      await sandbox.setTimeout(refreshTimeoutMs).catch(() => {});
      const session = buildSession(sandbox, refreshTimeoutMs);
      const id = sandbox.sandboxId;

      return {
        session: {
          id,
          resolvePath,
          async setNetworkPolicy() {
            // E2B doesn't expose per-domain egress rules through the
            // basic SDK surface used here; no-op rather than throwing so
            // authored code that calls this doesn't hard-fail.
          },
          async removePath(opts: { path: string; force?: boolean; recursive?: boolean }) {
            try {
              await withRetry('files.remove', () => sandbox.files.remove(resolvePath(opts.path)));
            } catch (err) {
              if (!opts.force) throw err;
            }
          },
          ...session,
        } as never,
        useSessionFn: (async () => session) as never,
        async captureState() {
          return { backendName: BACKEND_NAME, metadata: { sandboxId: id }, sessionKey: input.sessionKey };
        },
        async shutdown() {
          await sandbox.kill().catch(() => {});
        },
      };
    },
  };
}

async function createFromTemplate(
  input: SandboxBackendCreateInput,
  apiKey: string,
  options: E2BBackendOptions,
): Promise<E2BSandbox> {
  if (!input.templateKey) {
    return withRetry('Sandbox.create', () => E2BSandbox.create(BASE_TEMPLATE, { apiKey, timeoutMs: options.timeoutMs ?? 5 * 60 * 1000, lifecycle: SANDBOX_LIFECYCLE }));
  }
  const template = await prisma.sandboxTemplate.findUnique({ where: { templateKey: input.templateKey } });
  if (!template) {
    throw new Error(
      `[e2b] no snapshot found for template "${input.templateKey}" — run \`eve build\` (prewarm) before serving traffic.`,
    );
  }
  return withRetry('Sandbox.create', () => E2BSandbox.create(template.snapshotId, { apiKey, timeoutMs: options.timeoutMs ?? 5 * 60 * 1000, lifecycle: SANDBOX_LIFECYCLE }));
}

export { defineSandbox };
