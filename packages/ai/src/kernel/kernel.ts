/**
 * Shared "kernel" abstraction backing every sandboxed tool (Python execution,
 * browser automation, and anything else Phase 1 needs a real Linux VM for).
 *
 * REWRITTEN after upgrading `@vercel/sandbox` 1.10.2 -> 2.4.0 (checked via
 * `npm view @vercel/sandbox versions` + the real installed .d.ts, not
 * assumed): the first draft of this file hand-rolled session persistence
 * with an in-process `Map<sessionId, sandboxId>` because the installed
 * v1.10.2 types had no such primitive. v2.4.0 ships the real thing —
 * `Sandbox.getOrCreate({ name, persistent, onCreate, onResume })` — so that
 * hand-rolled map is gone; this now just calls the SDK's own idempotent
 * named-sandbox flow. Confirmed from vercel.com/docs/sandbox/concepts (live
 * docs) + node_modules/@vercel/sandbox/dist/sandbox.d.ts (installed types)
 * that this is real, current behavior, not a guess:
 *
 *   - `persistent: true` (the default): on stop, the SDK auto-snapshots the
 *     filesystem; the next call against the same `name` auto-resumes from
 *     that snapshot. This is a genuine capability upgrade over how the
 *     first draft (and E2B's typical session model) worked — no explicit
 *     save/restore step needed at all.
 *   - `Sandbox.getOrCreate({ name, onCreate })` — idempotent: resumes the
 *     named sandbox if it exists, creates + runs `onCreate` (one-time
 *     install/setup) only the first time. Direct equivalent of "warm
 *     template + persistent session" in one call.
 *   - `source: { type: 'snapshot', snapshotId }` — boot a FRESH sandbox from
 *     an offline-baked snapshot (see scripts/bake-kernel-snapshots.ts, TODO)
 *     instead of resuming a named one — used when you want N independent
 *     warm sandboxes rather than one shared persistent session.
 *   - `Sandbox.fork({ sourceSandbox })` — branch a running sandbox's
 *     filesystem + config into a new independent sandbox. Not used by the
 *     Python/browser tools yet, but a real primitive worth having for a
 *     future "run N variations from one warmed-up base" tool.
 *   - `networkPolicy` (allow-all / deny-all / custom allow-list with
 *     per-domain header injection) — lets each kernel lock egress down to
 *     only what it needs instead of full internet access.
 *   - `sandbox.domain(port)` — expose a live HTTPS URL for a port the
 *     sandboxed process opens. Wired through for a future
 *     make-it-real/code-artifact tool that needs to serve a live preview.
 *   - `extendTimeout()` — keep a long session alive without a hard cap.
 */
import { Sandbox, type NetworkPolicy } from '@vercel/sandbox';

export type KernelRuntime = 'node24' | 'node22' | 'node26' | 'python3.13';

export interface KernelOptions {
  runtime: KernelRuntime;
  /**
   * Stable name for a persistent sandbox (e.g. a conversation/session id).
   * Reuses the same named sandbox across calls (auto-resumes via the SDK's
   * own snapshot-on-stop behavior). Omit for a one-shot, unnamed sandbox
   * that's always freshly created.
   */
  sessionId?: string;
  /** Pre-baked snapshot id (deps already installed) to boot a FRESH sandbox from — mutually exclusive in effect with sessionId reuse (a snapshot source always creates new). */
  snapshotId?: string;
  /** Domains the sandbox is allowed to reach. Omit for full access; pass a list to lock it down. */
  allowedDomains?: string[];
  /** One-time install/setup. Runs via `onCreate` only the first time a named sandbox is created, or always for one-shot sandboxes without a snapshot. */
  bootstrap?: (sandbox: Sandbox) => Promise<void>;
  timeoutMs?: number;
  /** Default env vars for every command run in this sandbox (e.g. AI_GATEWAY_API_KEY for tools like agent-browser's own `chat` command). */
  env?: Record<string, string>;
}

function networkPolicyFor(allowedDomains?: string[]): NetworkPolicy {
  if (!allowedDomains?.length) return 'allow-all';
  return { allow: allowedDomains };
}

export async function getKernel(opts: KernelOptions): Promise<Sandbox> {
  const timeout = opts.timeoutMs ?? 120_000;
  const networkPolicy = networkPolicyFor(opts.allowedDomains);

  if (opts.snapshotId) {
    // Explicit snapshot source always boots a fresh sandbox from that image.
    return Sandbox.create({
      source: { type: 'snapshot', snapshotId: opts.snapshotId },
      timeout,
      networkPolicy,
      env: opts.env,
    });
  }

  if (opts.sessionId) {
    // Idempotent: resumes the named, persistent sandbox if it already
    // exists (auto-restored from its last snapshot), otherwise creates it
    // and runs bootstrap exactly once. This is the "one sandbox per chat"
    // primitive — callers pass a stable per-conversation id as sessionId
    // and every call within that chat lands on the same persistent VM.
    return Sandbox.getOrCreate({
      name: opts.sessionId,
      runtime: opts.runtime,
      timeout,
      networkPolicy,
      persistent: true,
      env: opts.env,
      onCreate: opts.bootstrap,
    });
  }

  const fresh = await Sandbox.create({ runtime: opts.runtime, timeout, networkPolicy, persistent: false, env: opts.env });
  await opts.bootstrap?.(fresh);
  return fresh;
}

/** Save the current state of a sandbox (deps installed, etc.) as a reusable snapshot for fast future cold boots. */
export async function snapshotKernel(sandbox: Sandbox, expirationMs?: number) {
  return sandbox.snapshot({ expiration: expirationMs });
}
