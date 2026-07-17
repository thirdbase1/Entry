import { z } from 'zod';
import { prisma } from '@entry/db';
import type { ToolExecCtx } from './types.js';
import { safeExecute } from './safe-execute.js';

/**
 * "A browser preview powered by the sandbox of each chat" — the
 * eve-default-path half of that feature (see ChatPreview's schema
 * comment for the full split with the BYOK path).
 *
 * eve's own sandbox has no external handle outside a live agent turn —
 * confirmed against eve's own public SandboxSession type (no name
 * override, no domain()/port API; see apps/agent/agent/sandbox/
 * sandbox.ts and vercel-sandbox.d.ts's own comment: "Framework-injected
 * fields (name, ...) are excluded: the framework owns those"). So this
 * tool does the ENTIRE job itself, from inside the sandbox, the only
 * place that has one:
 *   1. probes a fixed list of common dev-server ports for something
 *      actually listening (a real TCP connect, not a guess),
 *   2. if found, starts (or reuses — idempotent, checks for an already-
 *      running tunnel for that port first) a `localtunnel` process
 *      exposing it publicly,
 *   3. writes the result to the ChatPreview row keyed by this chat, which
 *      is the ONLY thing the UI's polling endpoint ever reads for an
 *      eve-path chat (it has no other way to reach this sandbox).
 *
 * Persona.ts instructs the model to call this proactively right after it
 * starts a dev server — that's the actual mechanism behind "auto start
 * the preview", since nothing outside a real tool call can trigger it for
 * this path.
 *
 * FIXED 2026-07-15 (real slowness bug, part of the "tool calls make the
 * model extremely slow" report): port probing used to be up to FIVE
 * separate sandbox.run() calls in a loop, one full network round-trip to
 * the remote E2B sandbox each, each with its OWN 2s timeout -- worst case
 * (no dev server up yet, the common case right after starting one) was 5
 * round-trips and up to ~10s just to conclude "nothing's listening yet."
 * Now it's a single shell script, one round-trip, that checks all ports
 * itself and reports back which one (if any) is up -- worst case is now
 * one round-trip plus at most 5 x 0.5s of in-sandbox probing (2.5s),
 * entirely inside the same command, no repeated network hops.
 */
const PREVIEW_PORTS = [3000, 5173, 8080, 4173, 8000] as const;

async function probeAllPorts(sandbox: Awaited<ReturnType<ToolExecCtx['getSandbox']>>): Promise<number | null> {
  const script = PREVIEW_PORTS.map(p => `timeout 0.5 bash -c '</dev/tcp/127.0.0.1/${p}' 2>/dev/null && { echo UP:${p}; exit 0; }`).join('; ');
  const result = await sandbox.run({ command: `${script}; true` });
  const match = result.stdout.match(/UP:(\d+)/);
  return match ? Number(match[1]) : null;
}

type TunnelProvider = 'cloudflared' | 'localtunnel';

/**
 * Idempotent: if a tunnel for this exact port+provider is already
 * running (e.g. the model calls this tool twice in a row), reuse it
 * instead of spawning a second one.
 *
 * REWRITTEN (2026-07-16, real bug confirmed live end to end against a
 * real E2B sandbox: "preview url still failed 100%"). Two independent,
 * compounding root causes, both reproduced directly:
 *
 * 1. cloudflared was never installed in the shared base template, so
 *    `command -v cloudflared` always failed and this ALWAYS fell through
 *    to localtunnel — whose public loca.lt relay reliably hands back a
 *    URL string that then just hangs and times out on every real
 *    request (confirmed live: curl against a freshly-minted loca.lt URL
 *    never connected at all). cloudflared's free "quick tunnel" actually
 *    works (confirmed live: 200 OK in <0.5s) and is a ~25MB static
 *    binary installable on first use in a couple seconds, so it's now
 *    the primary (and, in practice, only-needed) provider.
 *
 * 2. The liveness check (and the old kill-stale-process step) used
 *    `pgrep -f "<pattern>"` / `pkill -f "<pattern>"` where `<pattern>`
 *    is a literal substring of the SAME shell command that runs the
 *    check — e.g. `sh -c 'pgrep -f "cloudflared tunnel --url ..." ...'`
 *    has that exact text sitting right there in its OWN command line,
 *    which `-f` matches against in full. Confirmed live: this made
 *    `pkill -f` kill the very shell invocation trying to launch the
 *    tunnel (a same-line self-kill, surfacing as a bare "signal:
 *    terminated" with the tunnel never actually starting), and made
 *    `pgrep -f`'s liveness check spuriously report "still alive" purely
 *    because of the pattern text appearing in its own invocation — which
 *    would then keep re-serving a stale/broken cached URL from the log
 *    file forever instead of ever relaunching. Replaced entirely with a
 *    PID-file (`kill -0 $(cat pidfile)`), which only ever matches the
 *    actual tracked process, never text inside whatever shell command
 *    happens to be checking it.
 */
async function startTunnel(
  sandbox: Awaited<ReturnType<ToolExecCtx['getSandbox']>>,
  port: number,
  provider: TunnelProvider
): Promise<string | null> {
  const logFile = `/tmp/.preview-tunnel-${provider}-${port}.log`;
  const pidFile = `/tmp/.preview-tunnel-${provider}-${port}.pid`;
  const urlPattern = provider === 'cloudflared' ? /https:\/\/[^\s]+\.trycloudflare\.com/ : /https:\/\/[^\s]+\.loca\.lt/;

  const status = await sandbox.run({
    command: `cat ${logFile} 2>/dev/null || true; echo __SPLIT__; test -f ${pidFile} && kill -0 "$(cat ${pidFile})" 2>/dev/null && echo YES || echo NO`,
  });
  const [existingLogOut, aliveOut] = status.stdout.split('__SPLIT__');
  const existingMatch = (existingLogOut ?? '').match(urlPattern);
  if (existingMatch && (aliveOut ?? '').includes('YES')) return existingMatch[0];

  // Stop whatever stale process this pidfile pointed at (if any) — a
  // plain PID kill, no text-pattern matching involved, so no self-kill
  // risk regardless of what the launch command below looks like.
  await sandbox.run({ command: `test -f ${pidFile} && kill "$(cat ${pidFile})" 2>/dev/null; rm -f ${pidFile}; true` });

  if (provider === 'cloudflared') {
    const install = await sandbox.run({
      command: `command -v cloudflared > /dev/null 2>&1 || (curl -fsSL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /usr/local/bin/cloudflared)`,
    });
    if (
      install.exitCode !== 0 &&
      !(await sandbox.run({ command: 'command -v cloudflared > /dev/null 2>&1 && echo YES || echo NO' })).stdout.includes('YES')
    ) {
      return null; // genuinely couldn't install (no egress?) — let the localtunnel fallback try
    }
    // `echo $!` captures the just-backgrounded process's real PID in the
    // SAME shell invocation that started it — the one thing a plain
    // `pkill -f <pattern>` guess could never reliably give us.
    await sandbox.run({
      command: `nohup cloudflared tunnel --url http://localhost:${port} > ${logFile} 2>&1 & echo $! > ${pidFile}; sleep 2`,
    });
  } else {
    await sandbox.run({
      command: `nohup npx --yes localtunnel --port ${port} > ${logFile} 2>&1 & echo $! > ${pidFile}; sleep 2`,
    });
  }

  // FIXED (2026-07-16, confirmed live): a single fixed sleep before
  // reading the log raced the tunnel's own URL-registration write often
  // enough to matter — reproduced directly (URL landed in the log at the
  // ~5s mark while the old code only waited exactly 5s once). Polling a
  // few times with short waits is both more reliable AND usually faster
  // in the common case where the URL is ready well before the old fixed
  // delay would have checked.
  for (let attempt = 0; attempt < 6; attempt++) {
    const log = await sandbox.run({ command: `cat ${logFile} 2>/dev/null || true` });
    const match = log.stdout.match(urlPattern);
    if (match) return match[0];
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return null;
}

export const getPreviewUrlTool = {
  description:
    'Check for a running dev server in your sandbox and expose it as a public preview URL the user can ' +
    'open in their browser. Call this right after you start a dev server (npm run dev, vite, etc.) so the ' +
    "preview panel in the chat header updates automatically — don't wait for the user to ask.",
  inputSchema: z.object({}),
  async execute(_input: Record<string, never>, ctx: ToolExecCtx) {
    const chatId = ctx.session.id;
    const sandbox = await ctx.getSandbox();

    const port = await probeAllPorts(sandbox);
    if (port != null) {
      let url = await startTunnel(sandbox, port, 'cloudflared');
      if (!url) url = await startTunnel(sandbox, port, 'localtunnel');

      if (!url) {
        await prisma.chatPreview.upsert({
          where: { chatId },
          create: { chatId, status: 'error', errorMessage: 'Dev server is up but no tunnel provider reported a URL in time.' },
          update: { status: 'error', errorMessage: 'Dev server is up but no tunnel provider reported a URL in time.', url: null, port },
        });
        return { available: false, port, error: 'Tunnel failed to start in time — try calling this again in a few seconds.' };
      }

      await prisma.chatPreview.upsert({
        where: { chatId },
        create: { chatId, url, port, status: 'live' },
        update: { url, port, status: 'live', errorMessage: null },
      });
      return { available: true, url, port };
    }

    await prisma.chatPreview.upsert({
      where: { chatId },
      create: { chatId, status: 'stopped' },
      update: { status: 'stopped', url: null, port: null, errorMessage: null },
    });
    return { available: false, error: 'No dev server is listening yet on any common port (3000/5173/8080/4173/8000). Start one first.' };
  },
};

getPreviewUrlTool.execute = safeExecute('get_preview_url', getPreviewUrlTool.execute) as typeof getPreviewUrlTool.execute;
