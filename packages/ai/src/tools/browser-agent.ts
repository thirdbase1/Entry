/**
 * Replaces providers/tools/browser-use.ts (browser_use).
 *
 * REWRITTEN after discovering agent-browser has a built-in AI-driven `chat`
 * command — confirmed via agent-browser.dev/commands ("agent-browser chat
 * '<task>' # AI chat: natural language browser control (single-shot)") and
 * vercel-labs/agent-browser#1310 on GitHub, which shows `chat` is itself
 * powered by the Vercel AI Gateway (fix in that issue: "export
 * AI_GATEWAY_API_KEY=gw_..."). That means the hand-rolled step-loop this
 * file used to have (generateObject deciding one of ~5 primitives per turn)
 * was reinventing something agent-browser already does natively, and worse
 * — using far less of its surface. agent-browser ships 50+ commands
 * (confirmed on agent-browser.dev: "Complete: 50+ commands for navigation,
 * forms, screenshots, network, storage, files, tabs, frames, and
 * debugging"); its own `chat` mode can reach all of them, where the old
 * step-loop only ever issued open/snapshot/click/fill/get-text.
 *
 * New approach: shell out to `agent-browser chat "<task>" --json` inside the
 * kernel, with the SAME AI_GATEWAY_API_KEY this whole stack already uses
 * (wired in browser-kernel.ts). This is also a closer match to the
 * original's contract than the step-loop was — browser-use.com's API was
 * also a single "give me a task, get a result" black box.
 *
 * "One sandbox per chat": pass `sessionId` (e.g. the conversation id) and
 * every call reuses one persistent kernel sandbox (kernel.ts's
 * `Sandbox.getOrCreate`) AND one isolated agent-browser `--session`
 * (cookies/tabs/auth state) for that whole chat, instead of a fresh
 * browser per task. Confirmed the ORIGINAL never had this: browser-use.ts
 * creates a brand new hosted task per call with no session/task-id reuse
 * anywhere in the file — so this is an intentional improvement, not a
 * restored capability.
 *
 * `agent-browser chat --json`'s exact output schema isn't published in the
 * docs I could find, so this parses defensively: tries JSON and reads
 * common field names, falling back to the raw stdout text as the result if
 * the shape doesn't match or isn't JSON at all.
 */
import { z } from 'zod';

import { runAgentBrowser } from '../kernel/browser-kernel';
import { toolError } from './error';
import { createTool } from './utils';

function extractResultText(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const candidate = parsed.response ?? parsed.message ?? parsed.output ?? parsed.result ?? parsed.text;
      if (typeof candidate === 'string') return candidate;
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Not JSON (or --json unsupported by the installed version) — use raw text.
  }
  return trimmed;
}

export const createBrowserAgentTool = (sessionId?: string) => {
  return createTool(
    { toolName: 'browser_use' },
    {
      description: 'Use the browser to accomplish a task, should try web search tools before using this.',
      inputSchema: z.object({
        task_description: z.string().describe('The task to accomplish'),
      }),
      execute: async ({ task_description }: { task_description: string }) => {
        try {
          const result = await runAgentBrowser(['chat', task_description, '--json'], sessionId);

          if (result.exitCode !== 0) {
            return toolError('Browser Agent Failed', result.stderr || `agent-browser exited with code ${result.exitCode}`);
          }

          return {
            status: 'finished',
            resultMarkdown: extractResultText(result.stdout),
          };
        } catch (e: any) {
          return toolError('Browser Agent Failed', e.message);
        }
      },
    }
  );
};
