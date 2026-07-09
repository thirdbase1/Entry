/**
 * Browser-automation kernel: a Node sandbox with agent-browser (Rust CLI,
 * github.com/vercel-labs/agent-browser) + Chrome for Testing installed,
 * built on the shared kernel (kernel.ts) so it gets session persistence,
 * snapshot fast-boot, and network-policy lockdown for free.
 *
 * Cold boot (no KERNEL_BROWSER_SNAPSHOT_ID configured) installs agent-browser
 * + downloads Chrome every time — slow (real npm install + a Chrome
 * download). Once a snapshot is baked from a warmed sandbox, boots are
 * effectively instant.
 *
 * AI_GATEWAY_API_KEY is forwarded into the sandbox's env — confirmed via
 * agent-browser's own GitHub issue tracker (vercel-labs/agent-browser#1310,
 * "chat command disabled ... fix: export AI_GATEWAY_API_KEY=gw_...") that
 * agent-browser's built-in `chat` command is itself powered by the Vercel AI
 * Gateway, using this exact env var. So the browser tool (browser-agent.ts)
 * doesn't need its own hand-rolled model-calling loop — agent-browser already
 * has a native one, using the SAME one credential this whole stack shares.
 */
import type { Sandbox } from '@vercel/sandbox';

import { getKernel } from './kernel';

const BROWSER_ALLOWED_DOMAINS = [
  'registry.npmjs.org',
  '*.npmjs.org',
  'storage.googleapis.com', // Chrome for Testing downloads
  'ai-gateway.vercel.sh', // agent-browser's own `chat` command calling the Gateway
  '*', // the whole point of this kernel is browsing arbitrary sites — TODO: narrow once per-task domain hints exist
];

async function bootstrapBrowserSandbox(sandbox: Sandbox) {
  const install = await sandbox.runCommand({ cmd: 'npm', args: ['install', '-g', 'agent-browser'] });
  if (install.exitCode !== 0) {
    throw new Error(`agent-browser install failed: ${await install.stderr()}`);
  }
  const chrome = await sandbox.runCommand({ cmd: 'agent-browser', args: ['install'] });
  if (chrome.exitCode !== 0) {
    throw new Error(`Chrome for Testing install failed: ${await chrome.stderr()}`);
  }
}

export interface AgentBrowserResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one agent-browser CLI invocation. Pass `sessionId` (e.g. the
 * conversation id) to reuse ONE persistent sandbox — and, via `--session`,
 * one isolated agent-browser browser session (cookies/tabs/auth state) —
 * for the whole chat, matching "one sandbox per chat." Omit it for a
 * one-shot sandbox.
 */
export async function runAgentBrowser(args: string[], sessionId?: string): Promise<AgentBrowserResult> {
  const sandbox = await getKernel({
    runtime: 'node24',
    sessionId: sessionId ? `browser:${sessionId}` : undefined,
    snapshotId: process.env.KERNEL_BROWSER_SNAPSHOT_ID,
    allowedDomains: BROWSER_ALLOWED_DOMAINS,
    bootstrap: bootstrapBrowserSandbox,
    env: process.env.AI_GATEWAY_API_KEY ? { AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY } : undefined,
  });
  const fullArgs = sessionId ? ['--session', sessionId, ...args] : args;
  const run = await sandbox.runCommand({ cmd: 'agent-browser', args: fullArgs });
  return { exitCode: run.exitCode, stdout: await run.stdout(), stderr: await run.stderr() };
}
