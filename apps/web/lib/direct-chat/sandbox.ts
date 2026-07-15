/**
 * Real, standalone Vercel Sandbox for the direct-model chat path
 * (/api/direct/chat), used by that route's `bash` and `browser_use` tools.
 *
 * Why this exists as its own thing instead of reusing eve's sandbox
 * (apps/agent/agent/sandbox/sandbox.ts): eve's `defineSandbox` /
 * `SandboxSession` machinery is entirely bound to eve's own session/agent
 * runtime lifecycle (see eve/sandbox's exports — there is no standalone
 * "just hand me a sandbox" API outside of an eve agent turn). The
 * direct-chat route is a deliberately separate, bare `streamText` call
 * with its own hand-rolled tool set (see that route's file comment for
 * why it bypasses eve entirely) — it never runs inside eve's runtime, so
 * it cannot reach eve's sandbox either. This was the actual reason
 * `execCtx.getSandbox` in that route used to just throw
 * "Sandbox tools are not available in direct-model chats yet." — bash and
 * browser_use silently had ZERO tool parity with the default (non-BYOK/
 * non-direct-pick) chat path, for every single BYOK and Gateway-direct
 * user, not because it's technically impossible but because no one had
 * wired a real sandbox in for this path yet. Confirmed (2026-07-11): a
 * BYOK user asking for "a live browser" got a truthful but wrong-feeling
 * "I don't have that" — truthful for THIS path as it stood, wrong because
 * the feature is fully available on the default path and there's no
 * product reason BYOK shouldn't have it too.
 *
 * Talks to the raw `@vercel/sandbox` SDK directly (the same package eve's
 * own `vercel()` backend wraps). `Sandbox.getOrCreate({ name })` gives us
 * the same "resume by id across turns, create once" semantics eve's
 * session-bound sandboxes have, keyed by chatId instead of an eve session
 * id. Bootstrap (agent-browser + Chrome for Testing + the python
 * packages python_coding's sibling tools expect) only runs once per named
 * sandbox via `onCreate`, mirroring apps/agent/agent/sandbox/sandbox.ts's
 * own bootstrap step-for-step so behavior matches the default path
 * exactly.
 *
 * Credentials: no explicit token/projectId/teamId passed — `@vercel/
 * sandbox` auto-detects Vercel's own OIDC token from the deployment
 * environment when running as a Vercel Function (same as eve's own
 * backend does), so this works in production with zero extra env vars.
 */
import { Sandbox } from '@vercel/sandbox';

export interface DirectChatSandbox {
  id: string;
  run(opts: { command: string; env?: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

async function bootstrap(sandbox: Sandbox): Promise<void> {
  // numpy/pandas/matplotlib preinstalled for python_coding-adjacent work,
  // same package set as the default path's sandbox.
  await sandbox.runCommand('bash', [
    '-c',
    'pip3 install --quiet --break-system-packages numpy pandas matplotlib',
  ]);
  // agent-browser (github.com/vercel-labs/agent-browser) + Chrome for
  // Testing, used by the browser_use tool below.
  await sandbox.runCommand('bash', ['-c', 'npm install -g agent-browser && agent-browser install']);
}

/** One sandbox per chat, created lazily on the first tool call that needs
 *  it and reused for every later turn in the same conversation. */
export async function getSandboxForChat(chatId: string): Promise<DirectChatSandbox> {
  const sandbox = await Sandbox.getOrCreate({
    name: `direct-chat-${chatId}`,
    timeout: 45 * 60 * 1000, // 45 min idle timeout — generous for a long back-and-forth turn
    resources: { vcpus: 2 },
    // Exposed for the browser-preview feature (see /api/chats/[sessionId]/
    // preview and the header "Preview" button) — up to 4 ports per
    // sandbox is the SDK's own hard limit, so this picks the 4 most
    // common dev-server defaults: Next/CRA/Express-style (3000), Vite dev
    // (5173), a generic fallback (8080), and Vite's own preview/build-serve
    // mode (4173). Whichever one the agent's dev server actually binds to
    // gets a real public https://*.vercel.run domain automatically via
    // sandbox.domain(port) — see getPreviewForChat below.
    ports: [3000, 5173, 8080, 4173],
    onCreate: async sbx => {
      await bootstrap(sbx);
    },
  });

  return {
    id: sandbox.name ?? chatId,
    async run({ command, env }) {
      // `env` here is passed straight through to @vercel/sandbox's own
      // per-call `runCommand` option — scoped to this one spawned
      // process only, never persisted to the sandbox's ambient env or
      // any file (see inject_credential.ts for why that distinction
      // matters: it's what makes a credential unreadable by any later,
      // separate command).
      const result = await sandbox.runCommand({ cmd: 'bash', args: ['-c', command], timeoutMs: 5 * 60 * 1000, env });
      const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
      return { exitCode: result.exitCode ?? 1, stdout, stderr };
    },
  };
}

export const PREVIEW_PORTS = [3000, 5173, 8080, 4173] as const;

/**
 * Browser-preview support (2026-07-11): probes each of PREVIEW_PORTS for
 * something actually listening (a plain TCP-connect check from INSIDE the
 * sandbox via /dev/tcp, not a guess), and returns the first live one's
 * public domain. Returns `{ available: false }` rather than throwing when
 * nothing is up yet (e.g. no dev server started) or the sandbox itself is
 * unreachable — this is read by a plain status-polling endpoint, so a
 * normal "nothing running yet" state must never look like a hard error.
 */
export async function getPreviewForChat(chatId: string): Promise<
  | { available: true; url: string; port: number }
  | { available: false; reason: string }
> {
  try {
    const sandbox = await Sandbox.getOrCreate({ name: `direct-chat-${chatId}`, ports: [...PREVIEW_PORTS] });
    for (const port of PREVIEW_PORTS) {
      const probe = await sandbox
        .runCommand('bash', ['-c', `timeout 2 bash -c '</dev/tcp/127.0.0.1/${port}' 2>/dev/null && echo UP || echo DOWN`], {
          timeoutMs: 5000,
        })
        .catch(() => null);
      const stdout = probe ? await probe.stdout() : '';
      if (stdout.includes('UP')) {
        return { available: true, url: sandbox.domain(port), port };
      }
    }
    return { available: false, reason: 'No dev server is listening on any of the preview ports yet.' };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * "Agent can restart it itself in case of an error." Stops the current
 * sandbox session outright (getOrCreate's default resume behavior is not
 * enough when the underlying VM/dev-server is actually wedged, not just
 * idle) so the NEXT getSandboxForChat/getPreviewForChat call creates a
 * fresh session. bootstrap() only re-runs if the whole named sandbox was
 * deleted, which this deliberately does NOT do — stop+resume keeps the
 * filesystem (so the user's code isn't lost), only recycles the VM/session.
 */
export async function restartSandboxForChat(chatId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const sandbox = await Sandbox.getOrCreate({ name: `direct-chat-${chatId}`, ports: [...PREVIEW_PORTS], resume: false });
    await sandbox.stop().catch(() => {});
    // Immediately resume so the sandbox is warm again by the time this
    // returns, rather than lazily on the next tool call.
    await Sandbox.getOrCreate({ name: `direct-chat-${chatId}`, ports: [...PREVIEW_PORTS] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
