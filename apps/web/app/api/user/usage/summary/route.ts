/**
 * Usage & Billing summary (owner ask 2026-07-26: "a usage page wired to
 * ALL models — gateway, BYOK, and shared — with an accurate token/cost
 * breakdown, daily and monthly totals").
 *
 * Reads straight off the UsageEvent ledger (packages/db/src/usage-metering.ts)
 * — the same rows every chat turn already writes via recordUsageEvent, per
 * admin.md §2's "capture, don't estimate" rule. Nothing here is
 * estimated: token counts are the provider's own verbatim usage object,
 * and cost is either the provider's own reported figure or a lookup
 * against ModelPriceRate at the rate effective when the call happened.
 *
 * Scope: the CURRENT signed-in user's own usage only (no cross-user
 * data) — this is the personal "Usage" settings tab, not the admin
 * cross-user billing view (a separate, future admin-only surface).
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@entry/db';
import { getUserSessionFromRequest } from '@entry/auth';
import { withApiErrorHandling } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

function isByok(provider: string): boolean {
  return provider.startsWith('byok:');
}
function isShared(provider: string): boolean {
  return provider.startsWith('shared:');
}
function providerKind(provider: string): 'gateway' | 'byok' | 'shared' {
  if (isShared(provider)) return 'shared';
  if (isByok(provider)) return 'byok';
  return 'gateway';
}

export const GET = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // One query, sliced three ways in JS below — the table is per-user and
  // per-account volume here is small (chat usage, not a data warehouse),
  // so a single fetch + in-memory grouping is simpler and just as fast as
  // three separate groupBy round-trips, and keeps "today" / "this month" /
  // "all time" guaranteed mutually consistent (same snapshot, no races
  // between separate queries landing on different sides of midnight).
  const events = await prisma.usageEvent.findMany({
    where: { userId },
    select: {
      model: true,
      provider: true,
      inputTokens: true,
      outputTokens: true,
      cacheCreationTokens: true,
      cacheReadTokens: true,
      faceValueUsd: true,
      priceRateId: true,
      success: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 20000, // generous cap; a personal usage page, not a full-account export
  });

  type Row = (typeof events)[number];
  const totalTokensOf = (r: Row) => r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens;
  const costOf = (r: Row) => Number(r.faceValueUsd);

  const sum = (rows: Row[]) => ({
    calls: rows.length,
    inputTokens: rows.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens: rows.reduce((a, r) => a + r.outputTokens, 0),
    cacheCreationTokens: rows.reduce((a, r) => a + r.cacheCreationTokens, 0),
    cacheReadTokens: rows.reduce((a, r) => a + r.cacheReadTokens, 0),
    totalTokens: rows.reduce((a, r) => a + totalTokensOf(r), 0),
    costUsd: rows.reduce((a, r) => a + costOf(r), 0),
  });

  const todayRows = events.filter(e => e.createdAt >= startOfToday);
  const monthRows = events.filter(e => e.createdAt >= startOfMonth);

  // Per model+provider breakdown, all-time — this is "every model the
  // user has used" (the actual ask), sorted by total tokens desc so the
  // heaviest-used model is always first.
  const byKey = new Map<string, Row[]>();
  for (const e of events) {
    const key = `${e.provider}\u0000${e.model}`;
    const arr = byKey.get(key) ?? [];
    arr.push(e);
    byKey.set(key, arr);
  }

  // Shared-provider spend caps: fetch every isShared provider row this
  // user has ever actually used, so the page can show "$X of $Y spent"
  // instead of just raw totals (the whole point of the cap being visible,
  // not just enforced silently server-side).
  const sharedProviderIds = Array.from(byKey.keys())
    .map(k => k.split('\u0000')[0])
    .filter(p => isShared(p))
    .map(p => p.slice('shared:'.length));
  const sharedProviderRows = sharedProviderIds.length
    ? await prisma.userModelProvider.findMany({
        where: { id: { in: sharedProviderIds } },
        select: { id: true, label: true, spendCapUsd: true },
      })
    : [];
  const sharedProviderMeta = new Map(sharedProviderRows.map(p => [p.id, p]));

  const byModel = Array.from(byKey.entries())
    .map(([key, rows]) => {
      const [provider, model] = key.split('\u0000');
      const kind = providerKind(provider);
      const agg = sum(rows);
      const unpricedCalls = rows.filter(r => r.priceRateId == null && kind !== 'byok').length;
      const lastUsedAt = rows.reduce((max, r) => (r.createdAt > max ? r.createdAt : max), rows[0].createdAt);
      const failedCalls = rows.filter(r => !r.success).length;
      const sharedMeta = kind === 'shared' ? sharedProviderMeta.get(provider.slice('shared:'.length)) : null;
      return {
        model,
        provider,
        providerKind: kind,
        providerLabel:
          kind === 'byok' ? provider.slice('byok:'.length) : kind === 'shared' ? sharedMeta?.label ?? 'Shared' : 'Entry',
        ...agg,
        unpricedCalls,
        failedCalls,
        lastUsedAt,
        spendCapUsd: sharedMeta?.spendCapUsd != null ? Number(sharedMeta.spendCapUsd) : null,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const sharedProviders = sharedProviderRows.map(p => {
    const spentUsd = byModel
      .filter(m => m.providerKind === 'shared' && m.provider === `shared:${p.id}`)
      .reduce((a, m) => a + m.costUsd, 0);
    const capUsd = p.spendCapUsd != null ? Number(p.spendCapUsd) : null;
    return {
      providerId: p.id,
      label: p.label,
      capUsd,
      spentUsd,
      remainingUsd: capUsd != null ? Math.max(0, capUsd - spentUsd) : null,
      percentUsed: capUsd != null && capUsd > 0 ? Math.min(100, (spentUsd / capUsd) * 100) : null,
    };
  });

  return NextResponse.json({
    today: sum(todayRows),
    month: sum(monthRows),
    allTime: sum(events),
    byModel,
    sharedProviders,
    // Surfaced so the UI can honestly say "as of this many recorded
    // calls" rather than implying it's a live-updating total between
    // page loads — this endpoint is a snapshot, not a subscription.
    generatedAt: now.toISOString(),
  });
});
