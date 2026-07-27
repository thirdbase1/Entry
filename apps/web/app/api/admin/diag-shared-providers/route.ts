/** One-off admin diagnostic (2026-07-27): list every isShared=true
 *  provider + its models (enabled flags included), across ALL users --
 *  used to check what the picker should be showing without needing a
 *  specific userId. Bearer ADMIN_DEBUG_TOKEN only, read-only. */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export async function GET(req: NextRequest) {
  if (!isAdminBearerAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const providers = await prisma.userModelProvider.findMany({
    where: { isShared: true },
    select: {
      id: true,
      label: true,
      compatibility: true,
      baseUrl: true,
      spendCapUsd: true,
      lastError: true,
      models: {
        select: { id: true, modelId: true, label: true, isEnabled: true, lastTestStatus: true, lastTestError: true },
      },
    },
  });
  return NextResponse.json({ ok: true, providers });
}
