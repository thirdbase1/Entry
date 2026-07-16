/**
 * Version history list — backs the chat's "Versions" tab/card feed (see
 * packages/db/src/chat-versioning.ts for the full design). Every chat
 * (both the default eve path and direct/BYOK) can browse its own history
 * read-only; only direct/BYOK chats can currently revert live (see
 * ./revert/route.ts) — same split as the existing Files tab.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';
import { prisma } from '@entry/db';

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const versions = await prisma.chatVersion.findMany({
    where: { chatId: sessionId },
    orderBy: { versionNumber: 'desc' },
    take: 200,
  });

  const headVersionNumber = versions[0]?.versionNumber ?? 0;
  const canRevertLive = Boolean(chat.byokModelId || chat.requestedModel);

  return Response.json({
    canRevertLive,
    versions: versions.map(v => ({
      versionNumber: v.versionNumber,
      summary: v.summary,
      filesChanged: v.filesChanged,
      linesAdded: v.linesAdded,
      linesRemoved: v.linesRemoved,
      revertedFromVersionNumber: v.revertedFromVersionNumber,
      createdAt: v.createdAt,
      isHead: v.versionNumber === headVersionNumber,
    })),
  });
}
