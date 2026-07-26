import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { findRateForModel, priceUsage, isByok } from '@entry/db/usage-metering';
import { isAdminBearerAuthorized } from '@/lib/admin-auth';
import { getUserSessionFromRequest } from '@entry/auth';
import { featureService } from '@entry/features';

/**
 * One-off admin backfill: re-prices every ALREADY-RECORDED UsageEvent row
 * that's currently unpriced (priceRateId null, faceValueUsd 0) against
 * ModelPriceRate as it stands NOW.
 *
 * Why this needs to exist at all (owner ask 2026-07-26: "why all this
 * price still not showing"): recordUsageEvent() only ever prices a call
 * against whatever rates exist AT THE MOMENT that call happens -- by
 * design, so a rate change later doesn't rewrite history it shouldn't.
 * But that also means calls logged before seed-model-prices ever ran are
 * permanently stuck showing "$0.00 + unpriced" even after the rate table
 * is populated, unless something explicitly goes back and re-prices
 * them. This is that something -- run once, right after seeding new
 * ModelPriceRate rows, to make existing history reflect the rates that
 * (deliberately) didn't exist yet when those calls were actually made.
 *
 * Leaves provider-reported-cost rows (priceRateId === 'provider-reported')
 * alone -- those were never "unpriced" to begin with, they're authoritative.
 */
export async function POST(req: NextRequest) {
  const bearerOk = isAdminBearerAuthorized(req);
  if (!bearerOk) {
    const { session } = await getUserSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!(await featureService.isAdmin(session.user.id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const rows = await prisma.usageEvent.findMany({
    where: { priceRateId: null },
    select: {
      id: true,
      model: true,
      createdAt: true,
      provider: true,
      inputTokens: true,
      outputTokens: true,
      cacheCreationTokens: true,
      cacheReadTokens: true,
    },
  });

  let repriced = 0;
  let stillUnmatched = 0;
  const unmatchedModels = new Set<string>();

  for (const row of rows) {
    const rate = await findRateForModel(row.model, row.createdAt);
    if (!rate) {
      stillUnmatched += 1;
      unmatchedModels.add(row.model);
      continue;
    }
    const faceValueUsd = priceUsage(
      {
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreationTokens: row.cacheCreationTokens,
        cacheReadTokens: row.cacheReadTokens,
      },
      rate
    );
    await prisma.usageEvent.update({
      where: { id: row.id },
      data: {
        faceValueUsd,
        actualCostUsd: isByok(row.provider) ? 0 : faceValueUsd,
        priceRateId: rate.id,
      },
    });
    repriced += 1;
  }

  return NextResponse.json({
    ok: true,
    totalUnpricedFound: rows.length,
    repriced,
    stillUnmatched,
    unmatchedModels: Array.from(unmatchedModels),
  });
}
