/**
 * Resolves either a raw workflow run id OR a chatId to the run id backing
 * that chat's most recent turn -- ALWAYS re-verified against a chat row
 * this specific user owns, never trusting a bare id from the URL on its
 * own (see [chatId]/stream/route.ts's file comment for why both shapes
 * can legitimately show up in that URL segment: WorkflowChatTransport
 * uses the raw workflowRunId for its own internal mid-send retry loop,
 * and the chatId for the public resume-on-mount path -- both funnel
 * through here so both routes enforce the exact same ownership check).
 */
import { prisma } from '@entry/db';

export async function resolveOwnedRunId(rawParam: string, userId: string): Promise<string | undefined> {
  const byRunId = await prisma.eveChatSession.findFirst({
    where: { userId, cursor: { path: ['workflowRunId'], equals: rawParam } },
    select: { id: true },
  });
  if (byRunId) return rawParam;

  const byChatId = await prisma.eveChatSession.findFirst({
    where: { id: rawParam, userId },
    select: { cursor: true },
  });
  const cursor = byChatId?.cursor;
  if (cursor && typeof cursor === 'object' && 'workflowRunId' in cursor) {
    const runId = (cursor as { workflowRunId?: unknown }).workflowRunId;
    if (typeof runId === 'string' && runId) return runId;
  }
  return undefined;
}
