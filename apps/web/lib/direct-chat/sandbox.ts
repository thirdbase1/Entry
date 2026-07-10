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
  run(opts: { command: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
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
    onCreate: async sbx => {
      await bootstrap(sbx);
    },
  });

  return {
    id: sandbox.name ?? chatId,
    async run({ command }) {
      const result = await sandbox.runCommand('bash', ['-c', command], { timeoutMs: 5 * 60 * 1000 });
      const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
      return { exitCode: result.exitCode ?? 1, stdout, stderr };
    },
  };
}
