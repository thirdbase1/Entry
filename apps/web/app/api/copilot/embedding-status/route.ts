import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';

/**
 * GET /api/copilot/embedding-status
 * Ported 1:1 from CopilotUserConfigModel.getUserEmbeddingStatus, exposed via
 * the original's `embeddingStatus` GraphQL field on CopilotContextType.
 *
 * Returns how many of the user's docs+files have been embedded, so the
 * library UI can show an indexing-progress indicator.
 */
export async function GET(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;

  const [fileTotal, fileEmbedded, docTotal, docEmbedded] = await Promise.all([
    prisma.aiUserFiles.count({ where: { userId } }),
    prisma.aiUserFiles.count({ where: { userId, embeddings: { some: {} } } }),
    prisma.aiUserDocs.count({ where: { userId } }),
    prisma.aiUserDocs.count({ where: { userId, embeddings: { some: {} } } }),
  ]);

  return NextResponse.json({
    total: fileTotal + docTotal,
    embedded: fileEmbedded + docEmbedded,
  });
}
