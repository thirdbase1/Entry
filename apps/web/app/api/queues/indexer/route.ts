/**
 * Consumer Route Handler for the "indexer" queue topic. See
 * queues/nightly/route.ts header comment for the pattern/wrapper reason.
 */
import { createQueueConsumer, QueueTopic } from '@entry/queue';

const handler = createQueueConsumer(QueueTopic.INDEXER);

export async function POST(req: Request) {
  return handler(req);
}
