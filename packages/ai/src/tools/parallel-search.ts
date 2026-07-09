/**
 * Replaces BOTH providers/tools/exa-search.ts + cloudsway-search.ts (web_search)
 * and exa-crawl.ts + cloudsway-read.ts (web_crawl) with Parallel
 * (docs.parallel.ai, parallel-web npm package — confirmed real: official
 * TS/Python SDKs, dedicated Search + Extract endpoints, and Parallel even
 * lists Vercel as a platform integration in their docs sidebar).
 *
 * Worth flagging: the ORIGINAL code already registered Exa AND Cloudsway
 * simultaneously under the same 'webSearch' case (see providers/provider.ts
 * getTools()) — i.e. it already had a redundant second web-search vendor
 * before this migration touched anything. This rewrite collapses that back
 * down to ONE canonical search + extract tool instead of carrying the
 * duplication forward.
 *
 * Parallel's two endpoints map directly onto the two tools we need:
 *   - POST /v1/search  (search_queries + objective -> ranked results with
 *     LLM-optimized excerpts) = the "web_search" replacement.
 *   - POST /v1/extract (urls[] + objective -> excerpts/full_content per URL)
 *     = the "web_crawl" replacement — a closer match to Exa's getContents()
 *     than Cloudsway's read endpoint was, since it also takes an `objective`
 *     to focus what's extracted.
 *
 * Output shape kept identical to the original tools (title/url/content/
 * favicon/publishedDate/author) — confirmed against the frontend renderer
 * (renderers/web-search-result.tsx), which reads exactly those field names.
 */
import Parallel from 'parallel-web';
import { z } from 'zod';

import { toolError } from './error';
import { createTool } from './utils';

let client: Parallel | null = null;
function getClient(apiKey: string): Parallel {
  if (!client) client = new Parallel({ apiKey });
  return client;
}

export const createParallelSearchTool = (config: { apiKey: string }) => {
  return createTool(
    { toolName: 'web_search' },
    {
      description: 'Search the web for information',
      inputSchema: z.object({
        query: z.string().describe('The query to search the web for.'),
        mode: z.enum(['MUST', 'AUTO']).describe('The mode to search the web for.'),
      }),
      execute: async ({ query, mode }: { query: string; mode: 'MUST' | 'AUTO' }) => {
        try {
          const parallel = getClient(config.apiKey);
          const result = await parallel.search({
            objective: query,
            search_queries: [query],
            // MUST -> highest-quality/most-thorough retrieval (mirrors the
            // original's `livecrawl: 'always'`); AUTO -> faster default.
            mode: mode === 'MUST' ? 'advanced' : 'basic',
          });

          return result.results.map(r => ({
            title: r.title ?? undefined,
            url: r.url,
            content: r.excerpts.join('\n'),
            favicon: undefined,
            publishedDate: r.publish_date ?? undefined,
            author: undefined,
          }));
        } catch (e: any) {
          return toolError('Parallel Search Failed', e.message);
        }
      },
    }
  );
};

export const createParallelExtractTool = (config: { apiKey: string }) => {
  return createTool(
    { toolName: 'web_crawl' },
    {
      description: 'Crawl the web url for information',
      inputSchema: z.object({
        url: z.string().describe('The URL to crawl (including http:// or https://)'),
      }),
      execute: async ({ url }: { url: string }) => {
        try {
          const parallel = getClient(config.apiKey);
          const result = await parallel.extract({
            urls: [url],
            objective: 'Extract the full readable content of this page',
            advanced_settings: { full_content: { max_chars_per_result: 100_000 } } as any,
          });

          if (result.errors.length && !result.results.length) {
            return toolError('Parallel Extract Failed', result.errors[0]!.content ?? 'unknown error');
          }

          return result.results.map(r => ({
            title: r.title ?? undefined,
            url: r.url,
            content: r.full_content ?? r.excerpts.join('\n'),
            favicon: undefined,
            publishedDate: r.publish_date ?? undefined,
            author: undefined,
          }));
        } catch (e: any) {
          return toolError('Parallel Extract Failed', e.message);
        }
      },
    }
  );
};
