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
// was asking Parallel's API for up to 100,000 chars of page content PER
// crawl, then handing that back whole with zero cap of its own on top --
// one single crawl call could account for a huge chunk of a chat's
// context by itself, permanently, since every past turn gets resent to
// the model. Lowered the upstream ask to 20,000 chars (matches bash's own
// new ceiling) and added a local truncation flag so the model can tell
// when it's seeing a partial page vs the whole thing.
const MAX_CRAWL_CHARS = 20_000;

export const webCrawl = {
  description: 'Crawl a web URL and extract its full readable content.',
  inputSchema: z.object({
    url: z.string().describe('The URL to crawl (including http:// or https://)'),
  }),
  async execute({ url }: { url: string }) {
    const parallel = getClient();
    const result = await parallel.extract({
      urls: [url],
      objective: 'Extract the full readable content of this page',
      advanced_settings: { full_content: { max_chars_per_result: MAX_CRAWL_CHARS } } as any,
    });

    if (result.errors.length && !result.results.length) {
      throw new Error(result.errors[0]!.content ?? 'Parallel extract failed');
    }

    return result.results.map(r => {
      const full = r.full_content ?? r.excerpts.join('\n');
      const truncated = full.length > MAX_CRAWL_CHARS;
      return {
        title: r.title ?? undefined,
        url: r.url,
        content: truncated ? full.slice(0, MAX_CRAWL_CHARS) : full,
        publishedDate: r.publish_date ?? undefined,
        ...(truncated ? { truncated: true } : {}),
      };
    });
  },
};

webCrawl.execute = safeExecute('web_crawl', webCrawl.execute) as typeof webCrawl.execute;
Object.assign(webCrawl, withAgentTimeout('web_crawl', webCrawl));
