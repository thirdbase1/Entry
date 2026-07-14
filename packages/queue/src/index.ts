/**
 * Replaces packages/backend/server/src/base/job/queue/{queue,executor,def}.ts.
 *
 * Original: BullMQ, one Redis-backed Queue + Worker per namespace
 * (nightly/notification/doc/copilot/indexer — from `Queue` enum in def.ts),
 * jobs dispatched within a namespace by job name via `@OnJob('ns.jobName')`
 * decorated handlers (scanner.ts).
 *
 * Vercel Queues (confirmed real & current via vercel.com/docs/queues,
 * currently in public beta, `@vercel/queue@0.3.1` installed and its actual
 * .d.ts checked — not assumed) has a different but directly analogous
 * shape: named "topics" instead of named queues, `send(topic, payload)` to
 * publish, and ONE consumer Route Handler per topic wired via
 * `experimentalTriggers` in vercel.json, built with `handleCallback(handler)`.
 *
 * Mapping: one Vercel Queue topic per original namespace. Since a topic has
 * no built-in "job name" concept the way a BullMQ queue does, the job name
 * travels inside the message envelope (`{ jobName, payload }`) — the
 * consumer route for each topic dispatches to a registered handler map by
 * that name, mirroring the original's `@OnJob` dispatch.
 */
import { send, handleCallback } from '@vercel/queue';

export enum QueueTopic {
  NIGHTLY_JOB = 'nightly',
  NOTIFICATION = 'notification',
  COPILOT = 'copilot',
  INDEXER = 'indexer',
}

export const QUEUE_TOPICS = Object.values(QueueTopic);

export function namespaceOf(jobName: string): string {
  const parts = jobName.split('.');
  if (parts.length < 2) {
    throw new Error(`Job name must contain at least one namespace like [namespace].[job], got [${jobName}].`);
  }
  return parts[0];
}

interface JobEnvelope<T = unknown> {
  jobName: string;
  payload: T;
}

/**
 * Publish-side API, mirrors the original JobQueue's `.add(name, payload)`
 * call sites so callers barely change.
 */
export const jobQueue = {
  async add<T = unknown>(jobName: string, payload: T, options?: { idempotencyKey?: string; delaySeconds?: number }) {
    const topic = namespaceOf(jobName);
    if (!QUEUE_TOPICS.includes(topic as QueueTopic)) {
      throw new Error(`Invalid job queue: ${topic}, must be one of [${QUEUE_TOPICS.join(', ')}].`);
    }
    const envelope: JobEnvelope<T> = { jobName, payload };
    return send(topic, envelope, options);
  },
};

type JobHandlerFn<T = any> = (payload: T) => Promise<void>;

/**
 * Per-topic handler registry, filled in by each namespace's job-handler
 * module (equivalent to scanning `@OnJob`-decorated methods in the
 * original). Call `registerJobHandler` at module init time.
 */
const handlerRegistry = new Map<string, JobHandlerFn>();

export function registerJobHandler<T = any>(jobName: string, handler: JobHandlerFn<T>) {
  handlerRegistry.set(jobName, handler);
}

/**
 * Build the consumer Route Handler for one topic. Put this in
 * `app/api/queues/<topic>/route.ts` and add the matching
 * `experimentalTriggers: [{ type: 'queue/v2beta', topic: '<topic>' }]`
 * entry to vercel.json (see queue.config.ts for the generated block).
 */
export function createQueueConsumer(topic: QueueTopic) {
  return handleCallback<JobEnvelope>(async (envelope, metadata) => {
    if (namespaceOf(envelope.jobName) !== topic) {
      // Defensive: shouldn't happen since jobQueue.add() routes by namespace,
      // but a mismatched envelope should fail loudly rather than silently drop.
      throw new Error(`Job [${envelope.jobName}] delivered on topic [${topic}], expected namespace [${topic}].`);
    }
    const handler = handlerRegistry.get(envelope.jobName);
    if (!handler) {
      console.warn(`Job handler for [${envelope.jobName}] not found (messageId=${metadata.messageId}).`);
      return;
    }
    await handler(envelope.payload);
  });
}

