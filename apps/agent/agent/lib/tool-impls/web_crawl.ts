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
      advanced_settings: { full_content: { max_chars_per_result: 100_000 } } as any,
    });

    if (result.errors.length && !result.results.length) {
      throw new Error(result.errors[0]!.content ?? 'Parallel extract failed');
    }

    return result.results.map(r => ({
      title: r.title ?? undefined,
      url: r.url,
      content: r.full_content ?? r.excerpts.join('\n'),
      publishedDate: r.publish_date ?? undefined,
    }));
  },
};
