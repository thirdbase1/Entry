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

/** Idempotent: if a tunnel for this exact port+provider is already
 *  running (e.g. the model calls this tool twice in a row), reuse it
 *  instead of spawning a second one — parse its already-logged URL back
 *  out rather than trusting process liveness alone.
 *
 *  FIXED 2026-07-15: the existing-log-check and the pgrep liveness check
 *  used to be two separate sandbox.run() round-trips; now one combined
 *  command does both and reports back in a single round-trip. */
async function startTunnel(
  sandbox: Awaited<ReturnType<ToolExecCtx['getSandbox']>>,
  port: number,
  provider: TunnelProvider
): Promise<string | null> {
  const logFile = `/tmp/.preview-tunnel-${provider}-${port}.log`;
  const urlPattern = provider === 'cloudflared' ? /https:\/\/[^\s]+\.trycloudflare\.com/ : /https:\/\/[^\s]+\.loca\.lt/;
  const processPattern = provider === 'cloudflared' ? `cloudflared tunnel --url http://localhost:${port}` : `localtunnel --port ${port}`;

  const status = await sandbox.run({
    command: `cat ${logFile} 2>/dev/null || true; echo __SPLIT__; pgrep -f ${JSON.stringify(processPattern)} > /dev/null && echo YES || echo NO`,
  });
  const [existingLogOut, aliveOut] = status.stdout.split('__SPLIT__');
  const existingMatch = (existingLogOut ?? '').match(urlPattern);
  if (existingMatch && (aliveOut ?? '').includes('YES')) return existingMatch[0];

  const startCmd =
    provider === 'cloudflared'
      ? `command -v cloudflared > /dev/null 2>&1 && (` +
        `pkill -f ${JSON.stringify(processPattern)} 2>/dev/null; ` +
        `nohup cloudflared tunnel --url http://localhost:${port} > ${logFile} 2>&1 & ` +
        `sleep 5)`
      : `pkill -f ${JSON.stringify(processPattern)} 2>/dev/null; ` + `nohup npx --yes localtunnel --port ${port} > ${logFile} 2>&1 & ` + `sleep 4`;

  const started = await sandbox.run({ command: startCmd });
  if (provider === 'cloudflared' && started.exitCode !== 0) return null; // cloudflared binary missing — let the fallback try
  const log = await sandbox.run({ command: `cat ${logFile} 2>/dev/null || true` });
  const match = log.stdout.match(urlPattern);
  return match ? match[0] : null;
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
