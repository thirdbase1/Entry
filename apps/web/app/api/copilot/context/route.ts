import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { parseContextConfig } from '@/lib/copilot-context';

/**
 * Copilot Context API
 * Ported 1:1 from the original's context resolver + `ContextSession`/
 * `CopilotContextModel`. Ownership lives inside `AiContext.config.userId`
 * (a JSON field), not a DB column — see lib/copilot-context.ts.
 *
 * POST   /api/copilot/context              — create a context for a session
 * GET    /api/copilot/context?sessionId=   — get context for a session
 * POST   /api/copilot/context/[id]/chat    — add a chat to context
 * POST   /api/copilot/context/[id]/doc     — add a doc to context
 * POST   /api/copilot/context/[id]/file    — add a file to context
 * DELETE /api/copilot/context/[id]/chat?sessionId=   — remove chat from context
 * DELETE /api/copilot/context/[id]/doc?docId=        — remove doc from context
 * DELETE /api/copilot/context/[id]/file?fileId=      — remove file from context
 */

/**
 * POST /api/copilot/context
 * Create a context for a given (eve-backed) chat session.
 * Body: { sessionId: string }
 */
export async function POST(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { sessionId } = await req.json();
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  // Verify the chat session belongs to the current user (checkChatSession in the original).
  const chatSession = await prisma.eveChatSession.findFirst({
    where: { id: sessionId, userId: session.user.id },
  });
  if (!chatSession) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const existing = await prisma.aiContext.findFirst({ where: { sessionId } });
  if (existing) {
    return NextResponse.json({ id: existing.id });
  }

  const context = await prisma.aiContext.create({
    data: {
      sessionId,
      config: { userId: session.user.id, chats: [], docs: [], files: [] },
    },
  });

  return NextResponse.json({ id: context.id }, { status: 201 });
}

/**
 * GET /api/copilot/context?sessionId=...&contextId=...
 * Get the context (attached chats/docs/files) for a session or context id.
 */
export async function GET(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId');
  const contextId = url.searchParams.get('contextId');

  if (!sessionId && !contextId) {
    return NextResponse.json({ error: 'sessionId or contextId is required' }, { status: 400 });
  }

  const row = contextId
    ? await prisma.aiContext.findFirst({ where: { id: contextId } })
    : await prisma.aiContext.findFirst({ where: { sessionId: sessionId! } });

  if (!row) {
    return NextResponse.json({ error: 'Context not found' }, { status: 404 });
  }

  const config = parseContextConfig(row.config);
  if (!config || config.userId !== session.user.id) {
    return NextResponse.json({ error: 'Context not found' }, { status: 404 });
  }

  return NextResponse.json({
    id: row.id,
    chats: config.chats,
    docs: config.docs,
    files: config.files.map(f => ({ ...f, mimeType: f.mimeType || 'application/octet-stream' })),
  });
}
