/**
 * Admin-only, read-only diagnostic (2026-07-21): inspect eveChatSession
 * rows directly, without the normal userId-ownership scoping every real
 * app route enforces. Needed to root-cause a live report ("new chat
 * stops instantly with no response" + "why is a new chat auto
 * deleting") where the error_logs table showed ZERO entries for the
 * affected time window -- meaning nothing threw server-side, so the only
 * way to see what's actually happening to the row itself is to look at
 * it directly instead of guessing from application-level logs. Same
 * admin-bearer-or-session gate as /api/admin/errors.
 *
 * GET ?id=<chatId>            -- single row's raw state (or "not found")
 * GET ?recent=20              -- most recently created rows, any user
 */
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export const GET = withApiErrorHandling(async (req: Request) => {
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) {
    const { session } = await getUserSessionFromRequest(req);
    if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const recent = url.searchParams.get('recent');

  if (id) {
    const row = await prisma.eveChatSession.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        title: true,
        byokModelId: true,
        requestedModel: true,
        createdAt: true,
        updatedAt: true,
        backgroundRunActive: true,
        backgroundRunId: true,
        events: true,
      },
    });
    if (!row) return Response.json({ found: false, id });
    const events = Array.isArray(row.events) ? row.events : [];
    const tailN = Math.min(Math.max(Number(url.searchParams.get('tail')) || 0, 0), 48);
    return Response.json({
      found: true,
      id: row.id,
      userId: row.userId,
      title: row.title,
      byokModelId: row.byokModelId,
      requestedModel: row.requestedModel,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      backgroundRunActive: row.backgroundRunActive,
      backgroundRunId: row.backgroundRunId,
      eventCount: events.length,
      lastEventPreview: events.length ? JSON.stringify(events[events.length - 1]).slice(0, 800) : null,
      tail: tailN ? events.slice(-tailN).map((e: any) => ({
        role: e?.role,
        parts: Array.isArray(e?.parts) ? e.parts.map((p: any) => ({ type: p?.type, text: typeof p?.text === 'string' ? p.text.slice(0, 300) : undefined, toolName: p?.toolName, state: p?.state })) : undefined,
      })) : undefined,
    });
  }

  const limit = Math.min(Math.max(Number(recent) || 20, 1), 100);
  const rows = await prisma.eveChatSession.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      userId: true,
      title: true,
      byokModelId: true,
      requestedModel: true,
      createdAt: true,
      updatedAt: true,
      events: true,
    },
  });
  return Response.json({
    rows: rows.map(r => ({
      id: r.id,
      userId: r.userId,
      title: r.title,
      byokModelId: r.byokModelId,
      requestedModel: r.requestedModel,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      eventCount: Array.isArray(r.events) ? r.events.length : 0,
    })),
  });
});
