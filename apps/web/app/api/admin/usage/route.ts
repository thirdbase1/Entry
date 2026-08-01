import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { featureService } from '@entry/features';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

async function isAuthorized(req: NextRequest): Promise<boolean> {
  if (isAdminBearerAuthorized(req)) return true;
  const { session } = await getUserSessionFromRequest(req);
  return !!session && (await featureService.isAdmin(session.user.id));
}

function parseDate(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function decimal(value: unknown): number { return Number(value ?? 0); }

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const url = new URL(req.url);
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
  const from = parseDate(url.searchParams.get('from'), defaultFrom);
  const to = parseDate(url.searchParams.get('to'), now);
  const userId = url.searchParams.get('userId') || undefined;
  const model = url.searchParams.get('model') || undefined;
  const provider = url.searchParams.get('provider') || undefined;
  const successParam = url.searchParams.get('success');
  const success = successParam === 'true' ? true : successParam === 'false' ? false : undefined;
  const requestedLimit = Number(url.searchParams.get('limit') || 100);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 100, 1), 500);

  const where = {
    createdAt: { gte: from, lte: to },
    ...(userId ? { userId } : {}),
    ...(model ? { model: { contains: model, mode: 'insensitive' as const } } : {}),
    ...(provider ? { provider: { contains: provider, mode: 'insensitive' as const } } : {}),
    ...(success === undefined ? {} : { success }),
  };

  const [events, aggregate, byModel, byUser, unpriced] = await Promise.all([
    prisma.usageEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, select: {
      id: true, userId: true, chatId: true, source: true, model: true, provider: true,
      inputTokens: true, outputTokens: true, cacheCreationTokens: true, cacheReadTokens: true,
      faceValueUsd: true, actualCostUsd: true, priceRateId: true, finishReason: true, success: true, createdAt: true,
    }}),
    prisma.usageEvent.aggregate({ where, _count: { _all: true }, _sum: {
      inputTokens: true, outputTokens: true, cacheCreationTokens: true, cacheReadTokens: true, faceValueUsd: true, actualCostUsd: true,
    }}),
    prisma.usageEvent.groupBy({ where, by: ['model'], _count: { _all: true }, _sum: {
      faceValueUsd: true, actualCostUsd: true, inputTokens: true, outputTokens: true,
    }, orderBy: { _count: { model: 'desc' } }, take: 50 }),
    prisma.usageEvent.groupBy({ where, by: ['userId'], _count: { _all: true }, _sum: {
      faceValueUsd: true, actualCostUsd: true,
    }, orderBy: { _sum: { faceValueUsd: 'desc' } }, take: 100 }),
    prisma.usageEvent.count({ where: { ...where, priceRateId: null } }),
  ]);

  const totalFace = decimal(aggregate._sum.faceValueUsd);
  const totalActual = decimal(aggregate._sum.actualCostUsd);
  return NextResponse.json({
    range: { from, to },
    filters: { userId: userId ?? null, model: model ?? null, provider: provider ?? null, success: success ?? null },
    summary: {
      events: aggregate._count._all,
      inputTokens: aggregate._sum.inputTokens ?? 0, outputTokens: aggregate._sum.outputTokens ?? 0,
      cacheCreationTokens: aggregate._sum.cacheCreationTokens ?? 0, cacheReadTokens: aggregate._sum.cacheReadTokens ?? 0,
      faceValueUsd: totalFace, actualCostUsd: totalActual, marginUsd: totalFace - totalActual,
      marginPercent: totalFace > 0 ? ((totalFace - totalActual) / totalFace) * 100 : 0, unpricedEvents: unpriced,
    },
    byModel: byModel.map(row => ({ ...row, faceValueUsd: decimal(row._sum.faceValueUsd), actualCostUsd: decimal(row._sum.actualCostUsd) })),
    byUser: byUser.map(row => ({ ...row, faceValueUsd: decimal(row._sum.faceValueUsd), actualCostUsd: decimal(row._sum.actualCostUsd) })),
    events: events.map(event => ({ ...event, faceValueUsd: decimal(event.faceValueUsd), actualCostUsd: decimal(event.actualCostUsd) })),
  });
}
