import Parallel from 'parallel-web';
import { z } from 'zod';
import { safeExecute } from './safe-execute.js';
import { withAgentTimeout } from './with-agent-timeout.js';

let client: Parallel | null = null;
function getClient(): Parallel {
  if (!client) {
    const apiKey = process.env.PARALLEL_API_KEY;
    if (!apiKey) throw new Error('PARALLEL_API_KEY is not set');
    client = new Parallel({ apiKey });
  }
  return client;
}

// CONTEXT-BLOAT FIX (2026-07-23, same incident as bash.ts's own comment --
// see there for the full 370K-token production crash writeup). This tool
// had no cap at all on excerpt length or result count -- a broad query
// returning several results, each with generous excerpts, added up fast
// and stuck around forever once baked into history. Capped per-result
// content and the number of results returned, with a truncation flag so
// the model knows when it's seeing a trimmed result.
const MAX_RESULT_CHARS = 4_000;
const MAX_RESULTS = 8;

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

    return result.results.slice(0, MAX_RESULTS).map(r => {
      const full = r.excerpts.join('\n');
      const truncated = full.length > MAX_RESULT_CHARS;
      return {
        title: r.title ?? undefined,
        url: r.url,
        content: truncated ? full.slice(0, MAX_RESULT_CHARS) : full,
        publishedDate: r.publish_date ?? undefined,
        ...(truncated ? { truncated: true } : {}),
      };
    });
  },
};

webSearch.execute = safeExecute('web_search', webSearch.execute) as typeof webSearch.execute;
Object.assign(webSearch, withAgentTimeout('web_search', webSearch));
