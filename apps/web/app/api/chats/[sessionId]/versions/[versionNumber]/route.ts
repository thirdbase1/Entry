/**
 * Single version's detail — backs the "History page" you land on after
 * tapping a version card: the list of files that changed in exactly this
 * version, each with its own +/- line stats (tapping a file then hits
 * ./diff for the actual line-by-line diff). No "Compare" here by design
 * (see chat-versioning.ts's file comment) — a version already represents
 * one snapshot; the only action available downstream is Revert.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';
import { prisma } from '@entry/db';

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string; versionNumber: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId, versionNumber: versionNumberStr } = await params;
  const versionNumber = Number(versionNumberStr);
  if (!Number.isInteger(versionNumber)) return Response.json({ error: 'Invalid version number' }, { status: 400 });

  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const version = await prisma.chatVersion.findUnique({ where: { chatId_versionNumber: { chatId: sessionId, versionNumber } } });
  if (!version) return Response.json({ error: 'Version not found' }, { status: 404 });

  const files = await prisma.chatVersionFile.findMany({
    where: { versionId: version.id },
    select: { path: true, changeType: true, linesAdded: true, linesRemoved: true },
    orderBy: { path: 'asc' },
  });

  const head = await prisma.chatVersion.findFirst({ where: { chatId: sessionId }, orderBy: { versionNumber: 'desc' } });

  return Response.json({
    versionNumber: version.versionNumber,
    summary: version.summary,
    filesChanged: version.filesChanged,
    linesAdded: version.linesAdded,
    linesRemoved: version.linesRemoved,
    revertedFromVersionNumber: version.revertedFromVersionNumber,
    createdAt: version.createdAt,
    isHead: head?.versionNumber === version.versionNumber,
    files,
  });
}
