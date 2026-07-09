/**
 * Consumer Route Handler for the "nightly" queue topic. Registered against
 * Vercel Queues via experimentalTriggers in vercel.json (see
 * packages/queue/vercel.queues.json for the block to merge in).
 *
 * Job handlers for this namespace get registered via registerJobHandler()
 * as each original @OnJob('nightly.*') method is ported — none ported yet
 * (tracked in ROADMAP.md Phase 2 remaining work).
 *
 * Wrapped in an explicit `(req: Request)` signature: Next.js's route-type
 * checker (`next build`'s real type-checking pass, confirmed by hitting
 * this error live) requires exported HTTP method handlers to accept
 * exactly `Request | NextRequest`, but @vercel/queue's `handleCallback()`
 * returns a handler typed to accept its own `CallbackRequestInput` union
 * (`Request | { request: Request }`) — a real Request satisfies that
 * union at runtime, so this thin wrapper is a type-level shim only.
 */
import { createQueueConsumer, QueueTopic } from '@entry/queue';

const handler = createQueueConsumer(QueueTopic.NIGHTLY_JOB);

export async function POST(req: Request) {
  return handler(req);
}
