/**
 * Real, standalone sandbox for the direct-model chat path (/api/direct/chat),
 * used by that route's `bash` and `browser_use` tools — i.e. every BYOK chat
 * and every Gateway-direct-model-pick chat.
 *
 * REWRITTEN (2026-07-16, real bug: "browser_use still doesn't work" +
 * "get_preview_url always fails" + "agent stops itself when a tool call is
 * killed by the platform", all reported against BYOK chats specifically).
 * Root cause, confirmed by reading this file's previous version end to end:
 * the whole-app migration off Vercel Sandbox onto E2B (see
 * apps/agent/agent/sandbox/e2b-backend.ts's file comment for why that
 * migration happened at all — Vercel Hobby-plan sandbox quota) only ever
 * touched eve's OWN root-agent path. This file is a second, fully
 * independent sandbox implementation that direct/BYOK chats use instead
 * (see this route's own comment history for why it exists standalone), and
 * it was never migrated — still talking to raw `@vercel/sandbox` this whole
 * time. That means every BYOK/direct chat has been hitting the exact same
 * Vercel quota/instability issues the E2B migration was supposed to have
 * fixed app-wide, PLUS its own bootstrap script here was missing the
 * apt-get shared-library install (libnss3/libatk-bridge2.0-0/libgbm1/
 * libasound2/...) that eve's sandbox.ts had to add to make headless Chrome
 * launch at all in a bare Debian container — so browser_use was doubly
 * broken on this path even before quota entered into it.
 *
 * Fix: drop the standalone Vercel Sandbox code entirely and talk to E2B
 * directly (same 'e2b' package eve's own backend already depends on), and
 * — rather than re-authoring (and risking re-diverging) a second bootstrap
 * script — reuse the exact same prewarmed E2B snapshot eve's root-agent
 * path already built and cached in the `SandboxTemplate` table. That
 * snapshot already has numpy/pandas/matplotlib, agent-browser, Chrome for
 * Testing, and the shared-lib fix all baked in from one single
 * battle-tested bootstrap script, so this path gets a cold sandbox that
 * ALREADY works instead of a from-scratch one that has to re-earn it.
 * (There's currently only one row in that table app-wide, so `findFirst`
 * is correct, not a shortcut — see ChatSandbox's schema comment.)
 *
 * Persistence: E2B has no "resume by name" like `@vercel/sandbox`'s
 * `getOrCreate({ name })` — only "reconnect by exact sandbox id" via
 * `Sandbox.connect(id)`. The `ChatSandbox` table (one row per chat) is the
 * missing persistence layer that makes resume-across-turns work here too.
 */
import { Sandbox as E2BSandbox, RateLimitError as E2BRateLimitError } from 'e2b';
import { prisma } from '@entry/db';
import { restoreLatestFilesToSandbox } from '@entry/db/chat-versioning';

export interface DirectChatSandbox {
  id: string;
  // `signal` added 2026-07-16 alongside bash.ts's own timeout fix -- forwarded
  // straight into E2B's commands.run({signal}) so a tool-local abort actually
  // cancels the in-flight command server-side, not just the caller's wait.
  run(opts: { command: string; env?: Record<string, string>; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

function resolveApiKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) {
    throw new Error(
      'E2B_API_KEY is not configured — bash/browser_use tools are unavailable on the direct-chat path until it is set.',
    );
  }
  return key;
}

// Kept identical to apps/agent/agent/sandbox/e2b-backend.ts's own retry
// policy (see that file's comment for the full "confirmed real bug"
// writeup this was born from) — duplicated rather than imported because
// apps/web and apps/agent are separate workspace packages with no shared
// "sandbox internals" package between them, not because the policy should
// ever differ. Keep these two in sync if either changes.
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
      console.warn(`[direct-chat/e2b] ${label} hit a retryable error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying in ${Math.round(delay)}ms:`, err instanceof Error ? err.message : err);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

const IDLE_TIMEOUT_MS = 45 * 60 * 1000; // 45 min — generous for a long back-and-forth turn, matches the old Vercel config
// Fallback base template + inline bootstrap, used ONLY if eve's root-agent
// path has genuinely never prewarmed its own snapshot yet (fresh env,
// nothing in SandboxTemplate). Mirrors apps/agent/agent/sandbox/sandbox.ts's
// bootstrap step for step (including the apt-get shared-libs fix) so this
// path is never worse off than the shared snapshot, just slower to start.
const FALLBACK_BASE_TEMPLATE = process.env.E2B_BASE_TEMPLATE ?? 'entry-agent-base';

async function bootstrapFallback(sandbox: E2BSandbox): Promise<void> {
  // E2B sandboxes run commands as a non-root `user` (confirmed live:
  // apt-get failed with "Could not open lock file /var/lib/apt/lists/lock
  // - open (13: Permission denied)" without sudo). Passwordless sudo is
  // available on this backend (unlike Vercel Sandbox where the default
  // user already has root) -- mirrors apps/agent/agent/sandbox/sandbox.ts.
  await sandbox.commands.run(
    'sudo apt-get update -qq && sudo apt-get install -y -qq libnss3 libatk-bridge2.0-0 libgbm1 libasound2 libxss1 libxrandr2 libxkbcommon0 libgtk-3-0',
    { timeoutMs: 5 * 60 * 1000 },
  );
  // Node 24 (2026-07-16, corrected from an earlier Node-22 attempt): Vitest
  // only needed >=20.19/22+, but agent-browser@0.32.0 itself declares
  // "engines": { "node": ">=24.0.0" } -- confirmed live, npm prints
  // EBADENGINE against Node 22 for exactly this package. Node 24 satisfies
  // both. `n`/npm global installs work fine as the non-root user here (no
  // sudo needed for these two, confirmed live) -- only apt-get needs it.
  await sandbox.commands.run('npm install -g n && n 24', { timeoutMs: 5 * 60 * 1000 });
  await sandbox.commands.run('pip3 install --quiet --break-system-packages numpy pandas matplotlib', { timeoutMs: 5 * 60 * 1000 });
  await sandbox.commands.run('npm install -g agent-browser && agent-browser install', { timeoutMs: 5 * 60 * 1000 });
}

async function createFreshSandbox(apiKey: string): Promise<E2BSandbox> {
  const template = await prisma.sandboxTemplate.findFirst();
  if (template) {
    return withRetry('Sandbox.create (shared snapshot)', () =>
      E2BSandbox.create(template.snapshotId, { apiKey, timeoutMs: IDLE_TIMEOUT_MS }),
    );
  }
  // No shared snapshot exists yet anywhere in the app — bootstrap inline
  // this one time rather than fail outright.
  const sandbox = await withRetry('Sandbox.create (fallback base template)', () =>
    E2BSandbox.create(FALLBACK_BASE_TEMPLATE, { apiKey, timeoutMs: IDLE_TIMEOUT_MS }),
  );
  await bootstrapFallback(sandbox);
  return sandbox;
}

async function persistSandboxId(chatId: string, sandboxId: string): Promise<void> {
  await prisma.chatSandbox.upsert({
    where: { chatId },
    create: { chatId, sandboxId },
    update: { sandboxId },
  });
}

/** One sandbox per chat, created lazily on the first tool call that needs
 *  it and reused for every later turn in the same conversation (persisted
 *  via ChatSandbox — see file comment). */
export async function getSandboxForChat(chatId: string): Promise<DirectChatSandbox> {
  const apiKey = resolveApiKey();
  const existing = await prisma.chatSandbox.findUnique({ where: { chatId } });

  let sandbox: E2BSandbox;
  let restoredFromEviction = false;
  if (existing) {
    try {
      sandbox = await withRetry('Sandbox.connect', () => E2BSandbox.connect(existing.sandboxId, { apiKey }));
      // Reconnecting resets the idle clock server-side already, but bump
      // it explicitly too so a long tool-heavy turn doesn't get cut short
      // mid-way through.
      await sandbox.setTimeout(IDLE_TIMEOUT_MS).catch(() => {});
    } catch {
      // Sandbox paused/expired/evicted — create a fresh one rather than
      // hard-failing the tool call.
      sandbox = await createFreshSandbox(apiKey);
      await persistSandboxId(chatId, sandbox.sandboxId);
      restoredFromEviction = true;
    }
  } else {
    sandbox = await createFreshSandbox(apiKey);
    await persistSandboxId(chatId, sandbox.sandboxId);
  }

  // See chat-versioning.ts's restoreLatestFilesToSandbox for the full bug
  // this closes ("sandbox wiped between turns" — an eviction used to
  // silently hand back a blank sandbox with zero restoration).
  if (restoredFromEviction) {
    await restoreLatestFilesToSandbox(chatId, {
      run: async ({ command }) => {
        const r = await sandbox.commands.run(command, { timeoutMs: 60_000 });
        return { exitCode: r.exitCode ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      },
    }).catch(() => {});
  }

  const id = sandbox.sandboxId;
  return {
    id,
    async run({ command, env, signal }) {
      // 5 min per-command ceiling is a server-side SAFETY NET only now --
      // in practice the caller's own signal (bash.ts's 120s
      // withTimeoutSignal) fires first and actually cancels the in-flight
      // E2B command via `signal` below, rather than just abandoning the
      // wait. PLUS the shared withRetry wrapper around the dispatch
      // itself, so a transient E2B 429/5xx getting the command started
      // gets absorbed instead of surfacing as a bare tool failure -- same
      // class of fix as e2b-backend.ts's own withRetry.
      const result = await withRetry('commands.run', () =>
        sandbox.commands.run(command, { timeoutMs: 5 * 60 * 1000, envs: env, signal }),
      );
      return { exitCode: result.exitCode ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
  };
}

export const PREVIEW_PORTS = [3000, 5173, 8080, 4173] as const;

/**
 * Browser-preview support. Probes each of PREVIEW_PORTS for something
 * actually listening (a plain TCP-connect check from INSIDE the sandbox),
 * returns the first live one's public URL via E2B's `getHost(port)`
 * (E2B's equivalent of Vercel Sandbox's `sandbox.domain(port)`). Returns
 * `{ available: false }` rather than throwing when nothing is up yet or
 * the sandbox itself is unreachable — read by a plain status-polling
 * endpoint, so "nothing running yet" must never look like a hard error.
 */
export async function getPreviewForChat(chatId: string): Promise<
  | { available: true; url: string; port: number }
  | { available: false; reason: string }
> {
  try {
    const apiKey = resolveApiKey();
    const existing = await prisma.chatSandbox.findUnique({ where: { chatId } });
    if (!existing) return { available: false, reason: 'No sandbox has been created for this chat yet.' };

    const sandbox = await withRetry('Sandbox.connect (preview)', () => E2BSandbox.connect(existing.sandboxId, { apiKey }));

    for (const port of PREVIEW_PORTS) {
      const probe = await sandbox.commands
        .run(`timeout 2 bash -c '</dev/tcp/127.0.0.1/${port}' 2>/dev/null && echo UP || echo DOWN`, { timeoutMs: 5000 })
        .catch(() => null);
      if (probe?.stdout?.includes('UP')) {
        return { available: true, url: `https://${sandbox.getHost(port)}`, port };
      }
    }
    return { available: false, reason: 'No dev server is listening on any of the preview ports yet.' };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * "Restart" button in the preview panel — what the user actually wants
 * from this is "my dev server is stuck/showing stale content, kick it",
 * NEVER "wipe every file I've built so far." FIXED (2026-07-16, real bug
 * reported directly: "the sandbox file's everything inside reset when I
 * click the restart button in the preview" — confirmed by reading the
 * previous version of this function, which killed the sandbox outright
 * and created a brand new one from the shared snapshot on every single
 * click, discarding all real work unconditionally, every time, even for
 * an ordinary "the preview looks stuck" click).
 *
 * Now mirrors exactly what the eve-default path's own `restart_sandbox`
 * tool already does safely (apps/agent/agent/lib/tool-impls/
 * restart_sandbox.ts): reconnect to the SAME existing sandbox, kill stuck
 * dev-server/tunnel processes only, then replay whatever command last
 * looked like it started one (`ChatPreview.lastServeCommand` — captured
 * by lib/tool-impls/bash.ts every time a backgrounded command runs).
 * Filesystem state is fully preserved. Recreating from the shared
 * snapshot is now strictly the FALLBACK path, only reached when the
 * existing sandbox is genuinely unreachable (expired/evicted/killed) —
 * exactly the case where there is nothing left to preserve anyway.
 */
export async function restartSandboxForChat(chatId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const apiKey = resolveApiKey();
    const existing = await prisma.chatSandbox.findUnique({ where: { chatId } });
    const preview = await prisma.chatPreview.findUnique({ where: { chatId } });

    if (existing) {
      try {
        const sandbox = await E2BSandbox.connect(existing.sandboxId, { apiKey });
        await sandbox.setTimeout(IDLE_TIMEOUT_MS).catch(() => {});
        // Same kill list as restart_sandbox.ts's tool version — stuck dev
        // server + tunnel processes only, never anything filesystem-wide.
        await sandbox.commands.run(
          'pkill -f localtunnel 2>/dev/null; pkill -f cloudflared 2>/dev/null; ' +
            'pkill -f "npm run dev" 2>/dev/null; pkill -f "npm start" 2>/dev/null; ' +
            'pkill -f vite 2>/dev/null; pkill -f "next dev" 2>/dev/null; true',
          { timeoutMs: 15_000 },
        );
        if (preview?.lastServeCommand) {
          await sandbox.commands.run(`nohup ${preview.lastServeCommand} > /tmp/.devserver.log 2>&1 & sleep 1`, {
            timeoutMs: 15_000,
          });
        }
        return { ok: true };
      } catch {
        // Existing sandbox is genuinely unreachable (expired/evicted) —
        // fall through to the from-scratch path below. This is the ONLY
        // case that should ever lose file state, and it's already lost
        // (the sandbox is gone) regardless of what this function does.
      }
    }

    const fresh = await createFreshSandbox(apiKey);
    await persistSandboxId(chatId, fresh.sandboxId);
    await restoreLatestFilesToSandbox(chatId, {
      run: async ({ command }) => {
        const r = await fresh.commands.run(command, { timeoutMs: 60_000 });
        return { exitCode: r.exitCode ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      },
    }).catch(() => {});
    if (preview?.lastServeCommand) {
      await fresh.commands
        .run(`nohup ${preview.lastServeCommand} > /tmp/.devserver.log 2>&1 & sleep 1`, { timeoutMs: 15_000 })
        .catch(() => {});
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
