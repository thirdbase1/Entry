import Parallel from 'parallel-web';
import { z } from 'zod';
import { safeExecute } from './safe-execute.js';

let client: Parallel | null = null;
function getClient(): Parallel {
  if (!client) {
    const apiKey = process.env.PARALLEL_API_KEY;
    if (!apiKey) throw new Error('PARALLEL_API_KEY is not set');
    client = new Parallel({ apiKey });
  }
  return client;
}

export const webSearch = {
  description: 'Search the web for information.',
  inputSchema: z.object({
    query: z.string().describe('The query to search the web for.'),
    mode: z.enum(['MUST', 'AUTO']).default('AUTO').describe('MUST for thorough/high-quality retrieval, AUTO for a faster default.'),
  }),
  async execute({ query, mode }: { query: string; mode?: 'MUST' | 'AUTO' }) {
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
};

webSearch.execute = safeExecute('web_search', webSearch.execute) as typeof webSearch.execute;
