/**
 * Consumer Route Handler for the "copilot" queue topic. See
 * queues/nightly/route.ts header comment for the pattern/wrapper reason.
 *
 * Registers the copilot.embedding.docs/.files job handlers (see
 * @entry/copilot/src/embedding/jobs.ts) on module init — this is the
 * process instance that needs them registered when a queued job callback
 * arrives.
 */
import { createQueueConsumer, QueueTopic } from '@entry/queue';
import { registerEmbeddingJobHandlers } from '@entry/copilot';

const ready = registerEmbeddingJobHandlers();

const handler = createQueueConsumer(QueueTopic.COPILOT);

export async function POST(req: Request) {
  await ready;
  return handler(req);
}
