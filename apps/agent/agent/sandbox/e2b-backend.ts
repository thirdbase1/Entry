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
import { Sandbox as E2BSandbox } from 'e2b';
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

export interface E2BBackendOptions {
  /** Falls back to process.env.E2B_API_KEY. */
  readonly apiKey?: string;
  /** Idle timeout before E2B auto-pauses an unused sandbox. Default 5 minutes. */
  readonly timeoutMs?: number;
}

const BACKEND_NAME = 'e2b';

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
function buildSession(sandbox: E2BSandbox) {
  return {
    async run(opts: { command: string; workingDirectory?: string; env?: Record<string, string>; abortSignal?: AbortSignal }) {
      const result = await sandbox.commands.run(opts.command, {
        cwd: opts.workingDirectory ?? '/workspace',
        envs: opts.env,
        // E2B's default per-command timeout is short; sandbox bootstrap
        // steps (apt-get, npm install -g) legitimately take minutes.
        timeoutMs: 15 * 60 * 1000,
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },

    async spawn(opts: { command: string; workingDirectory?: string; env?: Record<string, string>; abortSignal?: AbortSignal }) {
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

      const handle = await sandbox.commands.run(opts.command, {
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
      });

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
        const bytes = await sandbox.files.read(path, { format: 'bytes' });
        return toReadableStream(bytes as Uint8Array);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },

    async readBinaryFile(opts: { path: string; abortSignal?: AbortSignal }) {
      const path = resolvePath(opts.path);
      try {
        const bytes = await sandbox.files.read(path, { format: 'bytes' });
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
        text = await sandbox.files.read(path, { format: 'text' });
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
      await sandbox.files.write(resolvePath(opts.path), toArrayBuffer(bytes));
    },

    async writeBinaryFile(opts: { path: string; content: Uint8Array; abortSignal?: AbortSignal }) {
      await sandbox.files.write(resolvePath(opts.path), toArrayBuffer(opts.content));
    },

    async writeTextFile(opts: { path: string; content: string; encoding?: string; abortSignal?: AbortSignal }) {
      await sandbox.files.write(resolvePath(opts.path), opts.content);
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
      const sandbox = await E2BSandbox.create({ apiKey, timeoutMs: options.timeoutMs ?? 5 * 60 * 1000 });
      try {
        for (const seed of input.seedFiles) {
          const data = typeof seed.content === 'string' ? seed.content : toArrayBuffer(seed.content);
          await sandbox.files.write(resolvePath(seed.path), data);
        }
        if (input.bootstrap) {
          const session = buildSession(sandbox);
          await input.bootstrap({ use: async () => session as never });
        }
        const snapshot = await sandbox.createSnapshot();
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
      if (existingSandboxId) {
        try {
          sandbox = await E2BSandbox.connect(existingSandboxId, { apiKey });
        } catch {
          sandbox = await createFromTemplate(input, apiKey, options);
        }
      } else {
        sandbox = await createFromTemplate(input, apiKey, options);
      }

      const session = buildSession(sandbox);
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
              await sandbox.files.remove(resolvePath(opts.path));
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
    return E2BSandbox.create({ apiKey, timeoutMs: options.timeoutMs ?? 5 * 60 * 1000 });
  }
  const template = await prisma.sandboxTemplate.findUnique({ where: { templateKey: input.templateKey } });
  if (!template) {
    throw new Error(
      `[e2b] no snapshot found for template "${input.templateKey}" — run \`eve build\` (prewarm) before serving traffic.`,
    );
  }
  return E2BSandbox.create(template.snapshotId, { apiKey, timeoutMs: options.timeoutMs ?? 5 * 60 * 1000 });
}

export { defineSandbox };
