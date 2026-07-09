/**
 * Replaces packages/backend/server/src/plugins/copilot/tools/e2b-python-sandbox.ts
 *
 * Built on the shared kernel (kernel.ts): boots instantly from a baked
 * snapshot (numpy/pandas/matplotlib preinstalled) when
 * KERNEL_PYTHON_SNAPSHOT_ID is configured, and locks egress to pypi only
 * rather than full internet.
 *
 * "One sandbox per chat" (explicit deviation from the original, called out
 * rather than silently changed): checked the original e2b-python-sandbox.ts
 * source directly — its own docstring says "Each call to this tool runs in
 * a completely fresh, stateless environment... no variables, files, or
 * state are preserved between calls," and the code matches: `Sandbox.create()`
 * then `sbx.kill()` every single call, no session/task id anywhere. So the
 * original genuinely does NOT support sandbox reuse for Python execution —
 * this isn't restoring an existing capability, it's a real behavior change
 * the user asked for. Implemented as opt-in: pass a `sessionId` (e.g. the
 * conversation id) when creating this tool via `createVercelPythonSandboxTool`
 * and every call in that chat reuses the same persistent, `getOrCreate`'d
 * sandbox (variables/files DO persist across calls, closer to a real Jupyter
 * kernel). Omit it and each call gets a fresh one-shot sandbox, matching the
 * original's stateless contract exactly.
 *
 * Same tool contract (name, description, output shape) as the original so the
 * agent prompts and downstream renderers (chat/renderers/*) don't need to change.
 */
import { z } from 'zod';

import { getKernel } from '../kernel/kernel';
import { createTool } from './utils';

const PYTHON_ALLOWED_DOMAINS = ['pypi.org', 'files.pythonhosted.org'];

export const createVercelPythonSandboxTool = (sessionId?: string) => {
  return createTool(
    { toolName: 'python_sandbox' },
    {
      description: `
Execute a Python script in a secure Vercel Sandbox (Firecracker microVM, python3.13 runtime).

${
  sessionId
    ? '**Note:** This chat has a persistent sandbox — variables, installed packages, and files ' +
      'from previous calls in this conversation ARE available. You do not need to redeclare them.'
    : '**Note:** Each call runs in a fresh, isolated environment. No variables, files, or state are ' +
      'preserved between calls. If you need previous results, include all necessary code and context in a single script.'
}

Output is a JSON object with fields such as: "exitCode", "stdout", "stderr".
`,
      inputSchema: z.object({
        code: z.string().describe('Python script to execute'),
        timeoutMs: z.number().optional().default(60_000),
      }),
      execute: async ({ code, timeoutMs }: { code: string; timeoutMs?: number }) => {
        const sandbox = await getKernel({
          runtime: 'python3.13',
          timeoutMs,
          sessionId: sessionId ? `python:${sessionId}` : undefined,
          snapshotId: process.env.KERNEL_PYTHON_SNAPSHOT_ID,
          allowedDomains: PYTHON_ALLOWED_DOMAINS,
          bootstrap: async sb => {
            // Cold-boot fallback only — the snapshot path skips this entirely.
            await sb.runCommand({ cmd: 'pip3', args: ['install', '--quiet', 'numpy', 'pandas', 'matplotlib'] });
          },
        });

        try {
          await sandbox.fs.writeFile('script.py', code);
          const run = await sandbox.runCommand({ cmd: 'python3', args: ['script.py'] });
          const stdout = await run.stdout();
          const stderr = await run.stderr();

          // NOTE: uploading generated artifacts (plots/pdfs/etc.) from
          // /vercel/sandbox to blob storage and returning URLs, mirroring the
          // original's png/jpeg/pdf URL behavior, is TODO — needs the real
          // storage bucket wiring from CopilotStorage ported in Phase 2.
          return { exitCode: run.exitCode, stdout, stderr };
        } finally {
          // Persistent (sessionId) sandboxes auto-snapshot on stop and
          // resume next call — stopping here does NOT lose state.
          // One-shot sandboxes are discarded, matching the original.
          await sandbox.stop();
        }
      },
    }
  );
};
