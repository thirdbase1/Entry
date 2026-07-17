/**
 * Version history list — backs the chat's "Versions" tab/card feed (see
 * packages/db/src/chat-versioning.ts for the full design). Every chat
 * (both the default eve path and direct/BYOK) can browse its own history
 * read-only; only direct/BYOK chats can currently revert live (see
 * ./revert/route.ts) — same split as the existing Files tab.
 *
 * UPGRADED (2026-07-17, "improve history and versioning" push):
 *  - Real pagination via `?before=<versionNumber>` cursor + a page size
 *    of 50 (was a flat, un-paginated `take: 200` -- any chat with a
 *    genuinely long history beyond that had its oldest versions
 *    permanently unreachable, not just slow to load).
 *  - `headVersionNumber` is now its own dedicated MAX() query, always
 *    unaffected by pagination or search -- previously derived from
 *    `versions[0]`, which was only ever correct for the very first,
 *    unfiltered page; any older/filtered page would have mislabeled its
 *    own newest-in-page row as "Live".
 *  - Optional `?q=<search>` does a real server-side search (summary
 *    text contains, or an exact version-number match) instead of only
 *    ever being a client-side filter over whatever page happened to
 *    already be loaded.
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';
import { prisma } from '@entry/db';

const PAGE_SIZE = 50;

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const url = new URL(req.url);
  const beforeParam = url.searchParams.get('before');
  const before = beforeParam ? Number(beforeParam) : undefined;
  const q = url.searchParams.get('q')?.trim() || undefined;
  // "Reverts only" filter (2026-07-17) -- no schema change needed, just
  // an extra predicate on the already-existing `revertedFromVersionNumber`
  // column. Useful on a chat with a long, noisy history to quickly answer
  // "when did I actually roll something back" without scrolling past
  // every ordinary turn.
  const onlyReverts = url.searchParams.get('onlyReverts') === '1';

  const where: Record<string, unknown> = { chatId: sessionId };
  if (before && Number.isInteger(before)) where.versionNumber = { lt: before };
  if (onlyReverts) where.revertedFromVersionNumber = { not: null };
  if (q) {
    const asNumber = Number(q);
    // Also matches by touched file path (2026-07-17) -- "find the
    // version that changed auth.ts" used to be impossible; summary text
    // alone rarely mentions every path involved (a version with 12 files
    // only lists a few basenames -- see chat-versioning.ts's
    // `summarize()`). One extra indexed lookup against ChatVersionFile
    // for matching paths, folded into the same OR as everything else.
    const matchingVersionNumbers = await prisma.chatVersionFile.findMany({
      where: { chatId: sessionId, path: { contains: q, mode: 'insensitive' } },
      select: { versionNumber: true },
      distinct: ['versionNumber'],
      take: 500,
    });
    where.OR = [
      { summary: { contains: q, mode: 'insensitive' } },
      ...(Number.isInteger(asNumber) ? [{ versionNumber: asNumber }] : []),
      ...(matchingVersionNumbers.length ? [{ versionNumber: { in: matchingVersionNumbers.map(v => v.versionNumber) } }] : []),
    ];
  }

  // Aggregate totals (2026-07-17) -- deliberately a SEPARATE query over
  // the chat's FULL history (chatId only, no pagination/search/onlyReverts
  // predicate), so the header stat is always "this whole chat's history",
  // not "whatever happens to be on the currently loaded/filtered page" --
  // a single cheap aggregate, not N+1, and completely unaffected by the
  // `where` built above.
  const [versions, headVersion, totals] = await Promise.all([
    prisma.chatVersion.findMany({ where, orderBy: { versionNumber: 'desc' }, take: PAGE_SIZE + 1 }),
    prisma.chatVersion.findFirst({ where: { chatId: sessionId }, orderBy: { versionNumber: 'desc' } }),
    prisma.chatVersion.aggregate({
      where: { chatId: sessionId },
      _count: { _all: true },
      _sum: { linesAdded: true, linesRemoved: true },
    }),
  ]);
  const revertCount = await prisma.chatVersion.count({ where: { chatId: sessionId, revertedFromVersionNumber: { not: null } } });

  const hasMore = versions.length > PAGE_SIZE;
  const page = hasMore ? versions.slice(0, PAGE_SIZE) : versions;
  const headVersionNumber = headVersion?.versionNumber ?? 0;
  const canRevertLive = Boolean(chat.byokModelId || chat.requestedModel);

  return Response.json({
    canRevertLive,
    hasMore,
    headVersionNumber,
    totals: {
      versions: totals._count._all,
      linesAdded: totals._sum.linesAdded ?? 0,
      linesRemoved: totals._sum.linesRemoved ?? 0,
      reverts: revertCount,
    },
    versions: page.map(v => ({
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

/**
 * Rename a version's summary line (2026-07-17) -- lets a user turn the
 * auto-generated "Updated foo.ts, bar.ts" into a real milestone label
 * like "Working checkout flow" for their own later reference. Reuses the
 * existing `summary` column directly rather than adding a new one --
 * it's exactly the field the auto-summary already lives in, and every
 * reader of it (this list route, the diff view, the inline chat version
 * card) already treats it as just display text with no parsing
 * expectations. Available on every chat type (no live sandbox needed to
 * just relabel a DB row) — unlike revert/revert-file, which do need one.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  let body: { versionNumber?: number; summary?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { versionNumber, summary } = body;
  if (!Number.isInteger(versionNumber)) return Response.json({ error: 'Invalid version number' }, { status: 400 });
  if (typeof summary !== 'string' || !summary.trim()) return Response.json({ error: 'Label cannot be empty' }, { status: 400 });
  if (summary.length > 200) return Response.json({ error: 'Label is too long (200 characters max)' }, { status: 400 });

  const existing = await prisma.chatVersion.findFirst({ where: { chatId: sessionId, versionNumber } });
  if (!existing) return Response.json({ error: 'Version not found' }, { status: 404 });

  await prisma.chatVersion.update({ where: { id: existing.id }, data: { summary: summary.trim() } });
  return Response.json({ success: true, versionNumber, summary: summary.trim() });
}
