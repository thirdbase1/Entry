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
  revalidationKey: () => 'entry-browser-bootstrap-v2',

  async bootstrap({ use }) {
    const sandbox = await use();

    // numpy/pandas/matplotlib preinstalled for the python_coding /
    // task_analysis workflows (matches the original e2b tool's warm-start
    // package set).
    // Vercel Sandbox's base image ships Debian's PEP 668
    // "externally-managed-environment" guard on system pip, which refuses a
    // bare `pip3 install` (confirmed the hard way: bootstrap failed in
    // production with `error: externally-managed-environment`). Passing
    // `--break-system-packages` is the documented escape hatch for exactly
    // this case (a disposable, single-purpose sandbox container, not a
    // shared system Python) — see PEP 668 and Debian's own bug tracker for
    // this flag's intended use.
    await sandbox.run({ command: 'pip3 install --quiet --break-system-packages numpy pandas matplotlib' });

    // agent-browser (github.com/vercel-labs/agent-browser) + Chrome for
    // Testing, used by tools/browser_use.ts.
    //
    // FIXED (2026-07-11): confirmed the real cause of "browser use always
    // fails" — Vercel Sandbox's base image is a minimal Debian image with
    // NONE of headless Chrome's required shared libraries (libnss3,
    // libatk-bridge2.0-0, libgbm1, libasound2, etc. — this is the exact
    // same well-documented "Chrome in a bare Docker/Debian container"
    // problem every headless-Chrome-in-CI setup hits: see Puppeteer's own
    // troubleshooting docs). Without these, `agent-browser install`
    // downloads the Chrome-for-Testing binary just fine, but launching it
    // fails immediately on every single run (missing .so errors) — which
    // is indistinguishable from "the tool doesn't work" from the outside,
    // every single call. `apt-get install` these BEFORE `agent-browser
    // install` so the browser can actually launch once installed.
    await sandbox.run({
      command:
        'apt-get update -qq && apt-get install -y -qq --no-install-recommends ' +
        'libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libxkbcommon0 ' +
        'libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 ' +
        'libpango-1.0-0 libcairo2 fonts-liberation libappindicator3-1 xdg-utils ' +
        'libgtk-3-0 ca-certificates',
    });
    await sandbox.run({ command: 'npm install -g agent-browser' });
    const browserInstall = await sandbox.run({ command: 'agent-browser install' });
    if (browserInstall.exitCode !== 0) {
      // Don't let a flaky download silently poison the whole cached
      // template — surface it loudly in bootstrap logs (previously this
      // was never checked at all, so a failed install just meant every
      // browser_use call quietly failed forever with no diagnostic trail).
      console.error('[bootstrap] agent-browser install failed:', browserInstall.stderr);
      throw new Error(`agent-browser install failed (exit ${browserInstall.exitCode}): ${browserInstall.stderr.slice(0, 2000)}`);
    }

    // Preview-panel support (2026-07-11, see get_preview_url.ts).
    //
    // FIXED (2026-07-11): localtunnel's public relay (loca.lt) is a small,
    // community-run free service with no uptime guarantee — confirmed the
    // real cause of "preview tool always failed" is that loca.lt itself
    // routinely refuses connections / never assigns a subdomain in time,
    // independent of anything in our own code. Cloudflare's "quick tunnel"
    // (cloudflared, trycloudflare.com) is the actively-maintained,
    // production-grade equivalent — no signup/account/token needed, same
    // one-shot ease of use, materially more reliable uptime. Installed as
    // the primary path; get_preview_url.ts falls back to localtunnel only
    // if the cloudflared binary itself can't be fetched.
    await sandbox.run({
      command:
        'curl -fsSL -o /usr/local/bin/cloudflared ' +
        'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 ' +
        '&& chmod +x /usr/local/bin/cloudflared',
    });
    await sandbox.run({ command: 'npm install -g localtunnel' });
  },
});
