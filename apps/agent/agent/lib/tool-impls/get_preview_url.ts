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
 */
type TunnelProvider = 'cloudflared' | 'localtunnel';

/** Idempotent: if a tunnel for this exact port+provider is already
 *  running (e.g. the model calls this tool twice in a row), reuse it
 *  instead of spawning a second one — parse its already-logged URL back
 *  out rather than trusting process liveness alone. */
async function startTunnel(
  sandbox: Awaited<ReturnType<ToolExecCtx['getSandbox']>>,
  port: number,
  provider: TunnelProvider
): Promise<string | null> {
  const logFile = `/tmp/.preview-tunnel-${provider}-${port}.log`;
  const urlPattern = provider === 'cloudflared' ? /https:\/\/[^\s]+\.trycloudflare\.com/ : /https:\/\/[^\s]+\.loca\.lt/;
  const processPattern = provider === 'cloudflared' ? `cloudflared tunnel --url http://localhost:${port}` : `localtunnel --port ${port}`;

  const existingLog = await sandbox.run({ command: `cat ${logFile} 2>/dev/null || true` });
  const existingMatch = existingLog.stdout.match(urlPattern);
  const alreadyRunning = await sandbox.run({ command: `pgrep -f ${JSON.stringify(processPattern)} > /dev/null && echo YES || echo NO` });
  if (existingMatch && alreadyRunning.stdout.includes('YES')) return existingMatch[0];

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

const PREVIEW_PORTS = [3000, 5173, 8080, 4173, 8000] as const;

export const getPreviewUrlTool = {
  description:
    'Check for a running dev server in your sandbox and expose it as a public preview URL the user can ' +
    'open in their browser. Call this right after you start a dev server (npm run dev, vite, etc.) so the ' +
    "preview panel in the chat header updates automatically — don't wait for the user to ask.",
  inputSchema: z.object({}),
  async execute(_input: Record<string, never>, ctx: ToolExecCtx) {
    const chatId = ctx.session.id;
    const sandbox = await ctx.getSandbox();

    for (const port of PREVIEW_PORTS) {
      const probe = await sandbox.run({
        command: `timeout 2 bash -c '</dev/tcp/127.0.0.1/${port}' 2>/dev/null && echo UP || echo DOWN`,
      });
      if (!probe.stdout.includes('UP')) continue;

      // FIXED (2026-07-11, "preview tool always failed"): loca.lt (the
      // free public relay localtunnel depends on) has no uptime guarantee
      // and routinely just doesn't come up in time — confirmed the real
      // failure mode was the external relay itself, not this code.
      // cloudflared's "quick tunnel" (trycloudflare.com) is the primary
      // path now — actively maintained by Cloudflare, no signup/token
      // needed, materially more reliable. localtunnel is kept ONLY as a
      // fallback for the rare case cloudflared itself isn't reachable
      // (see sandbox.ts's bootstrap comment for why both are installed).
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
