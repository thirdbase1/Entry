/**
 * Overrides eve's built-in `web_search` (per eve/dist/.../defaults.d.ts:
 * "The local `execute` here is a throwing stub ... To run your own search
 * instead, replace this with `defineTool()` in `agent/tools/web_search.ts`"
 * — this file IS that replacement, not a spread-and-wrap, since there's no
 * real default execute to preserve).
 *
 * Uses Parallel (docs.parallel.ai, `parallel-web` npm package) instead of
 * whatever the model provider would otherwise manage — same choice made
 * for packages/ai/src/tools/parallel-search.ts and for the same reason:
 * confirmed real (official TS/Python SDKs, dedicated Search + Extract
 * endpoints, Vercel listed as a platform integration in Parallel's own
 * docs), collapses the original's redundant Exa+Cloudsway double-vendor
 * search down to one canonical implementation.
 *
 * Needs PARALLEL_API_KEY in the environment.
 */
import { defineTool } from 'eve/tools';
import Parallel from 'parallel-web';
import { z } from 'zod';

let client: Parallel | null = null;
function getClient(): Parallel {
  if (!client) {
    const apiKey = process.env.PARALLEL_API_KEY;
    if (!apiKey) throw new Error('PARALLEL_API_KEY is not set');
    client = new Parallel({ apiKey });
  }
  return client;
}

export default defineTool({
  description: 'Search the web for information.',
  inputSchema: z.object({
    query: z.string().describe('The query to search the web for.'),
    mode: z.enum(['MUST', 'AUTO']).default('AUTO').describe('MUST for thorough/high-quality retrieval, AUTO for a faster default.'),
  }),
  async execute({ query, mode }) {
    const parallel = getClient();
    const result = await parallel.search({
      objective: query,
      search_queries: [query],
      mode: mode === 'MUST' ? 'advanced' : 'basic',
    });

    return result.results.map(r => ({
      title: r.title ?? undefined,
      url: r.url,
      content: r.excerpts.join('\n'),
      publishedDate: r.publish_date ?? undefined,
    }));
  },
});
