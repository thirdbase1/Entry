/**
 * Export this chat's full version history as one plain-text/Markdown
 * file (2026-07-17, "improve versioning/revert/history x6" push) --
 * distinct from the existing per-version .tar.gz (that's ONE snapshot's
 * actual file contents; this is a readable log of every version's
 * metadata across the WHOLE chat, good for a changelog/record rather
 * than restoring anything). Capped at 2000 versions -- generous for any
 * real chat, but keeps this from ever generating an unbounded response
 * on a pathological history.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';
import { prisma } from '@entry/db';

const EXPORT_CAP = 2000;

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const versions = await prisma.chatVersion.findMany({
    where: { chatId: sessionId },
    orderBy: { versionNumber: 'desc' },
    take: EXPORT_CAP,
  });

  // No Prisma relation between ChatVersion and ChatVersionFile (the
  // latter links by versionId/versionNumber, not a declared back-ref) --
  // one extra query for all touched files across these versions, grouped
  // in JS, instead of an N+1 per-version fetch.
  const versionIds = versions.map(v => v.id);
  const allFiles = versionIds.length
    ? await prisma.chatVersionFile.findMany({
        where: { versionId: { in: versionIds } },
        select: { versionId: true, path: true, changeType: true, linesAdded: true, linesRemoved: true },
        orderBy: { path: 'asc' },
      })
    : [];
  const filesByVersionId = new Map<string, typeof allFiles>();
  for (const f of allFiles) {
    const arr = filesByVersionId.get(f.versionId) ?? [];
    arr.push(f);
    filesByVersionId.set(f.versionId, arr);
  }

  const lines: string[] = [];
  lines.push(`# Version history — ${sessionId}`);
  lines.push('');
  lines.push(`Exported ${new Date().toISOString()} · ${versions.length} version${versions.length === 1 ? '' : 's'}`);
  lines.push('');

  for (const v of versions) {
    const revertNote = v.revertedFromVersionNumber != null ? ` (reverted from v${v.revertedFromVersionNumber})` : '';
    lines.push(`## Version #${v.versionNumber}${revertNote}`);
    lines.push(`${v.createdAt.toISOString()} — ${v.summary}`);
    lines.push(`${v.filesChanged} file${v.filesChanged === 1 ? '' : 's'} · +${v.linesAdded} / -${v.linesRemoved}`);
    for (const f of filesByVersionId.get(v.id) ?? []) {
      lines.push(`  - [${f.changeType}] ${f.path} (+${f.linesAdded}/-${f.linesRemoved})`);
    }
    lines.push('');
  }

  const body = lines.join('\n');
  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="history-${sessionId.slice(0, 8)}.md"`,
    },
  });
}
