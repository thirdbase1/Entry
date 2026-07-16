/**
 * Overrides eve's default sandbox to use a custom E2B-backed
 * SandboxBackend (see ./e2b-backend.ts) instead of `vercel()`.
 *
 * WHY: production hit Vercel Sandbox's Hobby-plan usage cap (402
 * payment_required, resets 2026-08-01, would otherwise require a Pro
 * plan upgrade). E2B (github.com/e2b-dev/e2b, Apache-2.0) is a
 * genuinely open-source sandbox provider reachable over plain HTTPS —
 * no local Docker daemon or KVM needed, so it actually works inside a
 * Vercel serverless function (confirmed via eve's own docs that
 * docker()/microsandbox() both require host-level daemons unavailable
 * there). Falls back to vercel() automatically when E2B_API_KEY isn't
 * configured yet, so nothing breaks mid-migration.
 *
 * Also bakes the agent-browser + Chrome-for-Testing install into the
 * template's `bootstrap` hook.
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
import { e2b } from './e2b-backend.js';

export default defineSandbox({
  backend: process.env.E2B_API_KEY ? e2b() : vercel({ resources: { vcpus: 2 } }),

  // Bump this if the bootstrap steps below ever change, so eve knows to
  // rebuild the cached template instead of reusing a stale one.
  // Bumped v2 -> v3: bootstrap itself is unchanged, but the underlying
  // E2B base template changed (2GB RAM custom template instead of the
  // default ~480MB one -- see e2b-backend.ts's BASE_TEMPLATE) and the
  // Chrome launch now needs AGENT_BROWSER_ARGS set, both of which need a
  // fresh snapshot, not a reused stale one.
  revalidationKey: () => 'entry-browser-bootstrap-v5',

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
    // Node 22 (2026-07-16): the base E2B template ships Node 20.9.0, but
    // Vitest and modern tooling require Node >= 20.19 or Node 22+. Install
    // Node 22 via `n` early in bootstrap so every subsequent npm/npx/node
    // call in this snapshot and in live sessions picks up Node 22 from
    // /usr/local/bin (which precedes /usr/bin in PATH). `n` is the
    // lightest reliable approach -- pure npm package, no curl-to-bash,
    // installs in a few seconds, idempotent. Bump revalidationKey (v3->v4)
    // forces eve to rebuild the snapshot rather than reuse the stale one.
    await sandbox.run({ command: 'sudo npm install -g n && sudo n 24 && node --version' });

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
    // E2B sandboxes run commands as a non-root `user` (confirmed via
    // `whoami` against a live sandbox) -- apt-get needs the lock files
    // under /var/lib/apt, which that user can't write, so a bare apt-get
    // fails immediately with exit code 100 ("Could not open lock file ...
    // Permission denied"). E2B ships passwordless sudo for exactly this
    // (verified `sudo -n true` succeeds), unlike Vercel Sandbox where the
    // default user already has root, so this needs sudo only on the e2b
    // backend path.
    await sandbox.run({
      command:
        'sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends ' +
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

    // FIXED (2026-07-15, confirmed live against a real E2B sandbox):
    // launching Chrome with agent-browser's default process model never
    // responds to CDP inside E2B's container -- Chrome's own internal
    // setuid/user-namespace sandbox can't initialize there (same class of
    // issue as headless-Chrome-in-Docker; Puppeteer's own troubleshooting
    // docs recommend the identical flags). Confirmed root cause the hard
    // way: launching the same Chrome binary manually with --no-sandbox
    // responds to CDP immediately; without it, every single call hung
    // until "CDP command timed out: Page.enable". `--args`/
    // AGENT_BROWSER_ARGS is agent-browser's own documented escape hatch
    // for exactly this (confirmed via its --help output). The real,
    // per-call fix lives in tools/browser_use.ts's runCli(), which passes
    // this env on every invocation; this bootstrap-time check exists so a
    // regression (e.g. a future agent-browser version dropping the flag,
    // or the base template losing RAM) fails loudly in build logs instead
    // of silently poisoning the cached snapshot for every real session.
    const browserSmokeTest = await sandbox.run({
      command: 'agent-browser --session bootstrap-smoke-test open https://example.com --json && agent-browser --session bootstrap-smoke-test close',
      env: { AGENT_BROWSER_ARGS: '--no-sandbox,--disable-dev-shm-usage,--disable-gpu' },
    });
    if (browserSmokeTest.exitCode !== 0) {
      console.error('[bootstrap] agent-browser smoke test failed:', browserSmokeTest.stdout, browserSmokeTest.stderr);
      throw new Error(
        `agent-browser smoke test failed (exit ${browserSmokeTest.exitCode}) -- Chrome cannot actually launch in this ` +
          `sandbox template. stdout: ${browserSmokeTest.stdout.slice(0, 1000)} stderr: ${browserSmokeTest.stderr.slice(0, 1000)}`,
      );
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
