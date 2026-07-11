/**
 * Browser-preview endpoint (2026-07-11) — backs the header "Preview"
 * button and its panel. See ChatPreview's schema comment for the full
 * two-path rationale (direct/BYOK has a real external sandbox handle;
 * the default eve path does not, so it only reads whatever the
 * get_preview_url tool last wrote from inside a live agent turn).
 */
import { getUserSessionFromRequest } from '@entry/auth';
import { getChatSession } from '@entry/copilot';
import { prisma } from '@entry/db';
import { getSandboxForChat, getPreviewForChat, restartSandboxForChat } from '@/lib/direct-chat/sandbox';

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const isDirect = Boolean(chat.byokModelId || chat.requestedModel);

  if (isDirect) {
    try {
      await getSandboxForChat(sessionId);
    } catch (err) {
      return Response.json({
        status: 'error',
        available: false,
        isDirect: true,
        requiresAgentAction: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const preview = await getPreviewForChat(sessionId);
    if (preview.available) {
      await prisma.chatPreview.upsert({
        where: { chatId: sessionId },
        create: { chatId: sessionId, url: preview.url, port: preview.port, status: 'live' },
        update: { url: preview.url, port: preview.port, status: 'live', errorMessage: null },
      });
      return Response.json({ status: 'live', available: true, url: preview.url, port: preview.port, isDirect: true, requiresAgentAction: false });
    }
    await prisma.chatPreview.upsert({
      where: { chatId: sessionId },
      create: { chatId: sessionId, status: 'stopped' },
      update: { status: 'stopped', url: null, errorMessage: preview.reason },
    });
    return Response.json({ status: 'stopped', available: false, reason: preview.reason, isDirect: true, requiresAgentAction: false });
  }

  const row = await prisma.chatPreview.findUnique({ where: { chatId: sessionId } });
  if (!row) {
    return Response.json({
      status: 'stopped',
      available: false,
      isDirect: false,
      requiresAgentAction: true,
      reason: 'No preview has been started for this chat yet. Ask the agent to run your app and it will appear here.',
    });
  }
  return Response.json({
    status: row.status,
    available: row.status === 'live',
    url: row.url,
    port: row.port,
    isDirect: false,
    requiresAgentAction: row.status !== 'live',
    reason: row.errorMessage,
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { sessionId } = await params;
  const chat = await getChatSession(session.user.id, sessionId);
  if (!chat) return Response.json({ error: 'Not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  if (body?.action !== 'restart') return Response.json({ error: 'Unknown action' }, { status: 400 });

  const isDirect = Boolean(chat.byokModelId || chat.requestedModel);

  if (isDirect) {
    const result = await restartSandboxForChat(sessionId);
    if (result.ok) {
      await prisma.chatPreview.upsert({
        where: { chatId: sessionId },
        create: { chatId: sessionId, status: 'starting' },
        update: { status: 'starting', url: null, errorMessage: null },
      });
    }
    return Response.json({ ...result, requiresAgentAction: false });
  }

  await prisma.chatPreview.upsert({
    where: { chatId: sessionId },
    create: { chatId: sessionId, status: 'stopped' },
    update: { status: 'stopped', url: null, errorMessage: null },
  });
  return Response.json({
    ok: true,
    requiresAgentAction: true,
    note: 'Ask the agent in chat to restart the preview — it has the tools to do this itself.',
  });
}
