import { NextRequest, NextResponse } from 'next/server';
import { prisma, encryptApiKey } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { z } from 'zod';

/**
 * GET /api/user/byok/providers
 * List the current user's BYOK provider connections, each with its models.
 * API keys are never returned — only whether one is set.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const providers = await prisma.userModelProvider.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'asc' },
    include: { models: { orderBy: { modelId: 'asc' } } },
  });

  return NextResponse.json({
    providers: providers.map(p => ({
      id: p.id,
      label: p.label,
      compatibility: p.compatibility,
      baseUrl: p.baseUrl,
      hasApiKey: !!p.encryptedApiKey,
      lastFetchedAt: p.lastFetchedAt,
      lastError: p.lastError,
      models: p.models.map(m => ({ id: m.id, modelId: m.modelId, label: m.label, isEnabled: m.isEnabled })),
    })),
  });
});

const CreateProviderSchema = z.object({
  label: z.string().min(1).max(100),
  compatibility: z.enum(['OPENAI', 'ANTHROPIC', 'GOOGLE']),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
});

/**
 * POST /api/user/byok/providers
 * Create a new BYOK provider connection. Does not fetch models —
 * call POST .../fetch-models afterwards (or add models manually).
 */
export const POST = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = CreateProviderSchema.safeParse(await req.json());
  if (!body.success) {
    return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  }

  const { label, compatibility, baseUrl, apiKey } = body.data;

  const provider = await prisma.userModelProvider.create({
    data: {
      userId: session.user.id,
      label,
      compatibility,
      baseUrl: baseUrl.replace(/\/+$/, ''), // normalize trailing slash
      encryptedApiKey: apiKey ? encryptApiKey(apiKey) : null,
    },
  });

  return NextResponse.json({
    id: provider.id,
    label: provider.label,
    compatibility: provider.compatibility,
    baseUrl: provider.baseUrl,
    hasApiKey: !!provider.encryptedApiKey,
    models: [],
  });
});
