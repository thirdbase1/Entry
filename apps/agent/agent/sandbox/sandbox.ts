/**
 * Overrides eve's default sandbox purely to pin the `vercel()` backend
 * explicitly (so local `eve dev` behaves identically to the hosted Vercel
 * deployment instead of falling back to Docker/microsandbox/just-bash —
 * confirmed via eve's own docs that `defaultBackend()` only picks Vercel
 * Sandbox automatically when `process.env.VERCEL` is set) and to bake the
 * agent-browser + Chrome-for-Testing install into the template's
 * `bootstrap` hook.
 *
 * This REPLACES packages/ai/src/kernel/browser-kernel.ts entirely — eve's
 * sandbox already gives us the persistent-session-with-resume, template
 * reuse, and network-policy lockdown that kernel.ts was hand-rolling on
 * top of raw @vercel/sandbox. `bootstrap` here is template-scoped (runs
 * once, cached across every session) which is a strict upgrade over our
 * hand-rolled KERNEL_BROWSER_SNAPSHOT_ID env var + manual snapshot-baking
 * script that was never actually written (flagged as TODO in the prior
 * session's notes) — eve does the equivalent automatically.
 *
 * Similarly, this sandbox replaces packages/ai/src/kernel/kernel.ts and
 * packages/ai/src/tools/vercel-sandbox.ts (the python_sandbox tool): eve's
 * built-in `bash` tool already runs arbitrary shell commands (including
 * `python3 script.py`) against this same sandbox, with the same
 * persistence/resume semantics, so there is no need to author a
 * dedicated python-execution tool at all.
 */
import { defineSandbox } from 'eve/sandbox';
import { vercel } from 'eve/sandbox/vercel';

export default defineSandbox({
  backend: vercel({ resources: { vcpus: 2 } }),

  // Bump this if the bootstrap steps below ever change, so eve knows to
  // rebuild the cached template instead of reusing a stale one.
  revalidationKey: () => 'entry-browser-bootstrap-v1',

  async bootstrap({ use }) {
    const sandbox = await use();

    // numpy/pandas/matplotlib preinstalled for the python_coding /
    // task_analysis workflows (matches the original e2b tool's warm-start
    // package set).
    await sandbox.run({ command: 'pip3 install --quiet numpy pandas matplotlib' });

    // agent-browser (github.com/vercel-labs/agent-browser) + Chrome for
    // Testing, used by tools/browser_use.ts.
    await sandbox.run({ command: 'npm install -g agent-browser' });
    await sandbox.run({ command: 'agent-browser install' });
  },
});
