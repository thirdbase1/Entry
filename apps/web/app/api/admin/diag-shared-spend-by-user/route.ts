/** One-off admin diagnostic (2026-07-27, owner report: "Usage" page's
 *  per-user "This month" total ($9.64) doesn't match the "Monthly usage"
 *  combined-pool bar ($9.72)) -- breaks down the current calendar month's
 *  shared:* UsageEvent rows BY userId so we can see exactly who/what
 *  accounts for the gap between one user's own total and the platform-wide
 *  pool getAllSharedSpendUsd() sums. Bearer ADMIN_DEBUG_TOKEN only,
 *  read-only. */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';

export async function GET(req: NextRequest) {
  if (!isAdminBearerAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));

  const rows = await prisma.usageEvent.findMany({
    where: { provider: { startsWith: 'shared:' }, createdAt: { gte: startOfMonth } },
    select: {
      id: true,
      userId: true,
      model: true,
      provider: true,
      faceValueUsd: true,
      actualCostUsd: true,
      success: true,
      priceRateId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const byUser = new Map<string, { faceValueSum: number; actualCostSum: number; calls: number }>();
  for (const r of rows) {
    const cur = byUser.get(r.userId) ?? { faceValueSum: 0, actualCostSum: 0, calls: 0 };
    cur.faceValueSum += Number(r.faceValueUsd);
    cur.actualCostSum += Number(r.actualCostUsd ?? 0);
    cur.calls += 1;
    byUser.set(r.userId, cur);
  }

  const totalFaceValue = rows.reduce((a, r) => a + Number(r.faceValueUsd), 0);
  const totalActualCost = rows.reduce((a, r) => a + Number(r.actualCostUsd ?? 0), 0);

  return NextResponse.json({
    ok: true,
    startOfMonth,
    totalRows: rows.length,
    totalFaceValueUsd: totalFaceValue,
    totalActualCostUsd: totalActualCost,
    byUser: Array.from(byUser.entries()).map(([userId, v]) => ({ userId, ...v })),
    rawRows: rows,
  });
}
