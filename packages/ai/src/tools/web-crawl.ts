/**
 * URL-content extraction tool. Superseded as the PRIMARY crawler by Parallel
 * Extract (tools/parallel-search.ts's web_crawl export) per the user's steer
 * to use Parallel for web search/retrieval — this agent-browser-backed
 * version is kept as a fallback for pages Parallel's fetcher can't render
 * (heavy client-side JS), since it drives a real Chrome instance.
 *
 * Uses agent-browser's `read` command (no URL arg) instead of manual
 * `get text` + `get title` — per agent-browser.dev/commands, `read` with no
 * URL "read[s] the rendered active-tab DOM ... including client-side
 * updates" and returns agent-friendly extracted text (closer to Exa's
 * getContents() output than raw innerText), so this now uses more of
 * agent-browser's actual command surface instead of the bare minimum.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { runAgentBrowser } from '../kernel/browser-kernel';
import { toolError } from './error';
import { createTool } from './utils';

export const createBrowserCrawlTool = (sessionId?: string) => {
  return createTool(
    { toolName: 'web_crawl_browser' },
    {
      description: 'Crawl a web URL for information by rendering it in a real browser (use for JS-heavy pages Parallel Extract cannot render).',
      inputSchema: z.object({
        url: z.string().describe('The URL to crawl (including http:// or https://)'),
      }),
      execute: async ({ url }: { url: string }) => {
        // Reuse the caller's session if given (e.g. shared with browser_use's
        // task loop); otherwise a scratch one-shot session for this single open+read.
        const sid = sessionId ?? randomUUID();
        try {
          const open = await runAgentBrowser(['open', url], sid);
          if (open.exitCode !== 0) {
            return toolError('Web Crawl Failed', open.stderr || 'failed to open URL');
          }

          const [rendered, title] = await Promise.all([
            runAgentBrowser(['read'], sid),
            runAgentBrowser(['get', 'title'], sid),
          ]);

          return [
            {
              title: title.stdout.trim(),
              url,
              content: rendered.stdout.slice(0, 100_000), // mirrors exa's maxCharacters: 100000
              favicon: undefined,
              publishedDate: undefined,
              author: undefined,
            },
          ];
        } catch (e: any) {
          return toolError('Web Crawl Failed', e.message);
        }
      },
    }
  );
};
