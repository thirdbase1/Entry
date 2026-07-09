import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';

/**
 * PATCH /api/copilot/prompts/[name]
 * Update a copilot prompt's messages.
 * Ported 1:1 from the original's updateCopilotPrompt mutation.
 *
 * Body: { messages: [{role, content, params?}] }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { name } = await params;
  const body = await req.json();
  const { messages, action, config, model, optionalModels } = body;

  if (!messages || !Array.isArray(messages)) {
    return NextResponse.json({ error: 'messages array is required' }, { status: 400 });
  }

  const existing = await prisma.aiPrompt.findUnique({ where: { name } });
  if (!existing) {
    return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
  }

  // Delete old messages and create new ones
  await prisma.aiPromptMessage.deleteMany({ where: { promptId: existing.id } });

  const updated = await prisma.aiPrompt.update({
    where: { name },
    data: {
      ...(action !== undefined ? { action } : {}),
      ...(config !== undefined ? { config } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(optionalModels !== undefined ? { optionalModels } : {}),
      messages: {
        create: messages.map((m: any, idx: number) => ({
          role: m.role,
          content: m.content,
          params: m.params || undefined,
          idx,
        })),
      },
    },
    include: { messages: { orderBy: { idx: 'asc' } } },
  });

  return NextResponse.json({
    name: updated.name,
    action: updated.action,
    model: updated.model,
    optionalModels: updated.optionalModels || [],
    config: updated.config || {},
    messages: updated.messages.map(m => ({
      role: m.role,
      content: m.content,
      params: m.params || undefined,
    })),
  });
}

/**
 * DELETE /api/copilot/prompts/[name]
 * Delete a copilot prompt.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { name } = await params;

  const existing = await prisma.aiPrompt.findUnique({ where: { name } });
  if (!existing) {
    return NextResponse.json({ error: 'Prompt not found' }, { status: 404 });
  }

  await prisma.aiPrompt.delete({ where: { name } });
  return NextResponse.json({ success: true });
}
