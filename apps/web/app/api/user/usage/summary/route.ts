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

  // "Today"/"this month" boundaries in the VIEWER's own timezone, not the
  // server's (owner bug report 2026-07-26: "daily usage is not correct" --
  // this route used `new Date(now.getFullYear(), ...)`, which resolves
  // against the Pxxl container's local tz (UTC), so anyone not in UTC saw
  // "today" cut off at the wrong wall-clock hour. The client passes its own
  // `Date.prototype.getTimezoneOffset()` value (minutes to ADD to local
  // time to get UTC) as `tzOffsetMinutes`; defaults to 0 (UTC) if absent so
  // this endpoint degrades gracefully for any caller that doesn't send it.
  const tzOffsetMinutes = Number(req.nextUrl.searchParams.get('tzOffsetMinutes')) || 0;
  const viewerLocalNow = new Date(now.getTime() - tzOffsetMinutes * 60_000);
  const startOfToday = new Date(
    Date.UTC(viewerLocalNow.getUTCFullYear(), viewerLocalNow.getUTCMonth(), viewerLocalNow.getUTCDate()) + tzOffsetMinutes * 60_000
  );
  const startOfMonth = new Date(
    Date.UTC(viewerLocalNow.getUTCFullYear(), viewerLocalNow.getUTCMonth(), 1) + tzOffsetMinutes * 60_000
  );

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
      source: true,
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
      const unpricedCalls = rows.filter(r => r.priceRateId == null).length;
      const lastUsedAt = rows.reduce((max, r) => (r.createdAt > max ? r.createdAt : max), rows[0].createdAt);
      const failedCalls = rows.filter(r => !r.success).length;
      const sharedMeta = kind === 'shared' ? sharedProviderMeta.get(provider.slice('shared:'.length)) : null;
      const modelCacheHitRate = agg.inputTokens + agg.cacheReadTokens > 0 ? agg.cacheReadTokens / (agg.inputTokens + agg.cacheReadTokens) : 0;
      return {
        model,
        provider,
        providerKind: kind,
        providerLabel:
          kind === 'byok' ? provider.slice('byok:'.length) : kind === 'shared' ? sharedMeta?.label ?? 'Shared' : 'Entry',
        ...agg,
        avgCostPerCallUsd: agg.calls > 0 ? agg.costUsd / agg.calls : 0,
        cacheHitRate: modelCacheHitRate,
        unpricedCalls,
        failedCalls,
        lastUsedAt,
        firstUsedAt: rows.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), rows[0].createdAt),
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

  // 14-day daily trend -- cost + tokens per calendar day, oldest first, so
  // the UI can render a simple bar chart without doing any date math
  // client-side. Days with zero events still get an explicit zero row
  // (never skipped) so the chart's x-axis stays evenly spaced.
  const trendDays = 14;
  // Bucket by the VIEWER's local calendar day, not the server container's
  // (same 2026-07-26 timezone bug as startOfToday/startOfMonth above --
  // this previously used `d.getFullYear()/getMonth()/getDate()`, which
  // resolves against the server's own tz regardless of who's looking at
  // the chart).
  const dayKey = (d: Date) => {
    const local = new Date(d.getTime() - tzOffsetMinutes * 60_000);
    return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
  };
  const byDay = new Map<string, Row[]>();
  for (const e of events) {
    const key = dayKey(e.createdAt);
    const arr = byDay.get(key) ?? [];
    arr.push(e);
    byDay.set(key, arr);
  }
  const dailyTrend = Array.from({ length: trendDays }, (_, i) => {
    // Pure millisecond arithmetic (24h per day) off the already-viewer-
    // local-midnight `startOfToday` instant -- avoids relying on the
    // server container's own tz/DST behavior for date-only math.
    const d = new Date(startOfToday.getTime() - (trendDays - 1 - i) * 86_400_000);
    const key = dayKey(d);
    const rows = byDay.get(key) ?? [];
    return { date: key, ...sum(rows) };
  });

  // Per-route breakdown ("source" = which server code path served the
  // call, e.g. "direct-chat" vs a future router path) -- separate axis
  // from per-model, useful for spotting a specific surface driving spend.
  const bySourceMap = new Map<string, Row[]>();
  for (const e of events) {
    const rows = bySourceMap.get(e.source) ?? [];
    rows.push(e);
    bySourceMap.set(e.source, rows);
  }
  const bySource = Array.from(bySourceMap.entries())
    .map(([source, rows]) => ({ source, ...sum(rows) }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const allTimeTotals = sum(events);
  const cacheHitRate =
    allTimeTotals.inputTokens + allTimeTotals.cacheReadTokens > 0
      ? allTimeTotals.cacheReadTokens / (allTimeTotals.inputTokens + allTimeTotals.cacheReadTokens)
      : 0;

  return NextResponse.json({
    today: sum(todayRows),
    month: sum(monthRows),
    allTime: allTimeTotals,
    averages: {
      costPerCallUsd: allTimeTotals.calls > 0 ? allTimeTotals.costUsd / allTimeTotals.calls : 0,
      tokensPerCall: allTimeTotals.calls > 0 ? allTimeTotals.totalTokens / allTimeTotals.calls : 0,
      cacheHitRate,
      failureRate: events.length > 0 ? events.filter(e => !e.success).length / events.length : 0,
    },
    byModel,
    bySource,
    dailyTrend,
    sharedProviders,
    // Surfaced so the UI can honestly say "as of this many recorded
    // calls" rather than implying it's a live-updating total between
    // page loads — this endpoint is a snapshot, not a subscription.
    generatedAt: now.toISOString(),
  });
});
