/**
 * Persists a completed TokenTracker report to Postgres.
 *
 * The original never had a single obvious "save the report" call site — it
 * accumulates `AiSession.tokenCost`/`messageCost` incrementally as part of
 * the copilot controller's existing session-save flow. Schema fields
 * checked directly (schema.prisma): `AiSession.tokenCost` (Int, running
 * total) and `AiSessionMessage.params` (Json, per-message metadata) are the
 * natural home — bump the session total and stash the detailed per-step
 * breakdown next to the message it belongs to.
 *
 * Call this once a chat stream finishes (after the assistant message is
 * saved), passing the tracker's report and the just-created message id.
 */
import { prisma } from '@entry/db';

import type { TokenUsageTracker } from './token-tracker';

export async function persistTokenUsage(params: {
  sessionId: string;
  assistantMessageId: string;
  tracker: TokenUsageTracker;
}) {
  const report = params.tracker.getTrackingReport();
  const { totalTokens } = report.summary;

  await prisma.$transaction([
    prisma.aiSession.update({
      where: { id: params.sessionId },
      data: { tokenCost: { increment: totalTokens }, messageCost: { increment: 1 } },
    }),
    prisma.aiSessionMessage.update({
      where: { id: params.assistantMessageId },
      data: {
        params: {
          tokenUsage: report.summary,
          records: report.details,
        } as any,
      },
    }),
  ]);

  return report;
}
