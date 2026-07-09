import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';

/**
 * Copilot Prompts API
 * Ported 1:1 from the original's prompt resolver.
 *
 * GET    /api/copilot/prompts          — list all prompts
 * POST   /api/copilot/prompts          — create a new prompt
 * PATCH  /api/copilot/prompts/[name]   — update a prompt
 */

/**
 * GET /api/copilot/prompts
 * List all copilot prompts.
 */
export async function GET(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const prompts = await prisma.aiPrompt.findMany({
    include: {
      messages: {
        orderBy: { idx: 'asc' },
      },
    },
  });

  return NextResponse.json(
    prompts.map(p => ({
      name: p.name,
      action: p.action || null,
      model: p.model,
      optionalModels: p.optionalModels || [],
      config: p.config || {},
      messages: p.messages.map(m => ({
        role: m.role,
        content: m.content,
        params: m.params || undefined,
      })),
    }))
  );
}

/**
 * POST /api/copilot/prompts
 * Create a new copilot prompt.
 * Body: { name, model, action?, config?, messages: [{role, content, params?}] }
 */
export async function POST(req: NextRequest) {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const { name, model, action, config, messages } = body;

  if (!name || !model || !messages || !Array.isArray(messages)) {
    return NextResponse.json({
      error: 'name, model, and messages are required',
    }, { status: 400 });
  }

  const existing = await prisma.aiPrompt.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json({ error: 'Prompt already exists' }, { status: 409 });
  }

  const prompt = await prisma.aiPrompt.create({
    data: {
      name,
      model,
      action: action || null,
      config: config || {},
      optionalModels: body.optionalModels || [],
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
    name: prompt.name,
    action: prompt.action,
    model: prompt.model,
    optionalModels: prompt.optionalModels || [],
    config: prompt.config || {},
    messages: prompt.messages.map(m => ({
      role: m.role,
      content: m.content,
      params: m.params || undefined,
    })),
  }, { status: 201 });
}
