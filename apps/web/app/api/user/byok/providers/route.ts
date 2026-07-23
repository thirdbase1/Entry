import { NextRequest, NextResponse } from 'next/server';
import { prisma, encryptApiKey } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';
import { z } from 'zod';
import { normalizeBaseUrl } from '@/lib/byok/normalize-base-url';

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
      models: p.models.map(m => ({
        id: m.id,
        modelId: m.modelId,
        label: m.label,
        isEnabled: m.isEnabled,
        reasoningEnabled: m.reasoningEnabled,
        lastTestedAt: m.lastTestedAt,
        lastTestStatus: m.lastTestStatus,
        lastTestError: m.lastTestError,
      })),
    })),
  });
});

const CreateProviderSchema = z
  .object({
    label: z.string().min(1).max(100),
    compatibility: z.enum(['OPENAI', 'ANTHROPIC', 'GOOGLE', 'OPENAI_RESPONSES', 'AI_GATEWAY']),
    // ADDED (2026-07-23, AI Gateway BYOK mode): every other compatibility
    // mode requires a real, user-supplied baseUrl -- AI_GATEWAY does not,
    // since createGateway() (build-model-client.ts) talks to Vercel's own
    // Gateway endpoint on its own and never reads this column for real
    // requests. Optional at the zod layer; the refine below still
    // enforces it for every OTHER mode exactly as before.
    baseUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
  })
  .refine(data => data.compatibility === 'AI_GATEWAY' || !!data.baseUrl, {
    message: 'Base URL is required for this compatibility mode.',
    path: ['baseUrl'],
  })
  .refine(data => data.compatibility !== 'AI_GATEWAY' || !!data.apiKey, {
    // ADDED (2026-07-23, real footgun): unlike every other mode, a
    // keyless AI_GATEWAY row isn't just "broken" -- @ai-sdk/gateway
    // silently falls back to OUR OWN shared AI_GATEWAY_API_KEY env var
    // when no key is passed (see build-model-client.ts's matching
    // guard, which is the actual hard stop; this is just the earliest,
    // clearest place to reject it). An API key is mandatory for this
    // mode specifically -- every other mode's "leave blank for key-less
    // endpoints" note does not apply here.
    message: 'An API key is required for AI Gateway -- unlike other modes, this one is never key-less.',
    path: ['apiKey'],
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
      // AI_GATEWAY: normalizeBaseUrl ignores whatever's passed (or
      // undefined) and always returns the fixed display value -- the
      // `?? ''` is only ever hit in that branch.
      baseUrl: normalizeBaseUrl(compatibility, baseUrl ?? ''),
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
