'use client';

/**
 * Personal "Usage" tab (owner ask 2026-07-26, expanded same day: "track
 * everything about AI usage — tokens AND $, model icons, very neat").
 * Every model the user has actually called — gateway, BYOK, and the
 * platform's shared relay keys — with an accurate token + cost
 * breakdown split by today / this month / all time, a 14-day trend, a
 * per-route breakdown, and honest cache/failure-rate stats. Reads
 * /api/user/usage/summary, which itself reads straight off the
 * UsageEvent ledger (never estimated — see that route's file comment).
 * Polls every 30s so it stays live while a chat is running.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { ModelIcon } from './model-icon';

interface Totals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
}

interface ModelRow extends Totals {
  model: string;
  provider: string;
  providerKind: 'gateway' | 'byok' | 'shared';
  providerLabel: string;
  avgCostPerCallUsd: number;
  cacheHitRate: number;
  unpricedCalls: number;
  failedCalls: number;
  lastUsedAt: string;
  firstUsedAt: string;
  spendCapUsd: number | null;
}

interface SourceRow extends Totals {
  source: string;
}

interface TrendDay extends Totals {
  date: string;
}

interface SharedProviderCap {
  providerId: string;
  label: string;
  capUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  percentUsed: number | null;
}

interface UsageSummary {
  today: Totals;
  month: Totals;
  allTime: Totals;
  averages: { costPerCallUsd: number; tokensPerCall: number; cacheHitRate: number; failureRate: number };
  byModel: ModelRow[];
  bySource: SourceRow[];
  dailyTrend: TrendDay[];
  sharedProviders: SharedProviderCap[];
  generatedAt: string;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const KIND_STYLE: Record<ModelRow['providerKind'], { label: string; className: string }> = {
  gateway: { label: 'Entry', className: 'bg-primary/10 text-primary' },
  byok: { label: 'Your key', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  shared: { label: 'Shared', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
};

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border rounded-lg p-4 flex flex-col gap-1 bg-card min-w-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold text-foreground truncate" style={{ letterSpacing: -0.24 }}>
        {value}
      </span>
      {sub ? <span className="text-xs text-muted-foreground truncate">{sub}</span> : null}
    </div>
  );
}

function TrendChart({ days }: { days: TrendDay[] }) {
  const max = Math.max(...days.map(d => d.costUsd), 0.0001);
  return (
    <div className="border rounded-lg p-4 bg-card">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-foreground">Last 14 days</span>
        <span className="text-xs text-muted-foreground">daily spend</span>
      </div>
      <div className="flex items-end gap-1.5 h-24">
        {days.map(d => (
          <div key={d.date} className="flex-1 flex flex-col items-center gap-1 group relative">
            <div className="w-full flex flex-col items-center justify-end h-20">
              <div
                className={cn('w-full rounded-sm transition-all', d.costUsd > 0 ? 'bg-primary/70 group-hover:bg-primary' : 'bg-muted')}
                style={{ height: `${Math.max(2, (d.costUsd / max) * 100)}%` }}
              />
            </div>
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">{fmtDay(d.date)}</span>
            <div className="pointer-events-none absolute bottom-full mb-1 hidden group-hover:flex flex-col items-center rounded-md bg-popover border px-2 py-1 text-[11px] shadow-md z-10 whitespace-nowrap">
              <span className="font-medium text-foreground">{fmtUsd(d.costUsd)}</span>
              <span className="text-muted-foreground">{fmtTokens(d.totalTokens)} tok · {d.calls} calls</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function downloadCsv(data: UsageSummary) {
  const header = ['model', 'source', 'provider_kind', 'calls', 'input_tokens', 'output_tokens', 'cache_tokens', 'total_tokens', 'cost_usd', 'last_used'];
  const lines = data.byModel.map(r =>
    [r.model, r.providerLabel, r.providerKind, r.calls, r.inputTokens, r.outputTokens, r.cacheCreationTokens + r.cacheReadTokens, r.totalTokens, r.costUsd.toFixed(6), r.lastUsedAt].join(',')
  );
  const csv = [header.join(','), ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `entry-usage-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function UsageSection() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      // Pass the viewer's own tz offset so "today"/"this month" boundaries
      // (and the daily trend chart) bucket by THEIR local calendar day, not
      // the server's (owner bug report 2026-07-26: "daily usage is not
      // correct" -- see summary/route.ts's tzOffsetMinutes handling).
      const tzOffsetMinutes = new Date().getTimezoneOffset();
      const res = await fetch(`/api/user/usage/summary?tzOffsetMinutes=${tzOffsetMinutes}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const json = (await res.json()) as UsageSummary;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // 3s poll (down from 30s, owner ask 2026-07-26: "make sure that page
    // usage updates instantly") -- plus an immediate refetch the moment the
    // tab regains focus/visibility, so switching back to it after a chat
    // turn never shows stale numbers waiting on the next tick.
    const interval = setInterval(load, 3_000);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [load]);

  const modelCount = useMemo(() => data?.byModel.length ?? 0, [data]);

  if (loading && !data) {
    return <div className="text-sm text-muted-foreground">Loading usage…</div>;
  }

  if (error && !data) {
    return (
      <div className="text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
        Couldn't load usage: {error}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {modelCount} model{modelCount === 1 ? '' : 's'} used · updated {fmtRelative(data.generatedAt)}
        </span>
        <button
          type="button"
          onClick={() => downloadCsv(data)}
          className="h-7 px-2.5 rounded-md text-xs border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          Export CSV
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Today" value={fmtUsd(data.today.costUsd)} sub={`${fmtTokens(data.today.totalTokens)} tokens · ${data.today.calls} calls`} />
        <StatCard label="This month" value={fmtUsd(data.month.costUsd)} sub={`${fmtTokens(data.month.totalTokens)} tokens · ${data.month.calls} calls`} />
        <StatCard label="All time spend" value={fmtUsd(data.allTime.costUsd)} sub={`${data.allTime.calls} calls total`} />
        <StatCard label="All time tokens" value={fmtTokens(data.allTime.totalTokens)} sub={`${fmtTokens(data.allTime.inputTokens)} in · ${fmtTokens(data.allTime.outputTokens)} out`} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Avg cost / call" value={fmtUsd(data.averages.costPerCallUsd)} />
        <StatCard label="Avg tokens / call" value={fmtTokens(data.averages.tokensPerCall)} />
        <StatCard label="Cache hit rate" value={fmtPct(data.averages.cacheHitRate)} sub="of input tokens served from cache" />
        <StatCard
          label="Failure rate"
          value={fmtPct(data.averages.failureRate)}
          sub={data.averages.failureRate > 0.1 ? 'higher than usual' : undefined}
        />
      </div>

      <TrendChart days={data.dailyTrend} />

      {data.sharedProviders.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">Shared provider budgets</span>
          {data.sharedProviders.map(p => (
            <div key={p.providerId} className="border rounded-lg p-4 bg-card flex flex-col gap-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-foreground">{p.label}</span>
                <span className="text-muted-foreground">
                  {fmtUsd(p.spentUsd)} {p.capUsd != null ? `of ${fmtUsd(p.capUsd)}` : '(uncapped)'}
                </span>
              </div>
              {p.percentUsed != null && (
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn('h-full rounded-full transition-all', p.percentUsed >= 100 ? 'bg-destructive' : p.percentUsed >= 80 ? 'bg-amber-500' : 'bg-primary')}
                    style={{ width: `${p.percentUsed}%` }}
                  />
                </div>
              )}
              {p.percentUsed != null && p.percentUsed >= 100 && (
                <span className="text-xs text-destructive">Budget exhausted — this provider's models are now blocked until the cap is raised.</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-foreground">By model</span>
        {data.byModel.length === 0 ? (
          <div className="text-sm text-muted-foreground border border-dashed rounded-lg px-4 py-6 text-center">
            No usage recorded yet — send a chat message to see it show up here.
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 font-medium text-right">Calls</th>
                    <th className="px-3 py-2 font-medium text-right">Input</th>
                    <th className="px-3 py-2 font-medium text-right">Output</th>
                    <th className="px-3 py-2 font-medium text-right">Cache</th>
                    <th className="px-3 py-2 font-medium text-right">Total tokens</th>
                    <th className="px-3 py-2 font-medium text-right">Cost</th>
                    <th className="px-3 py-2 font-medium text-right">Avg/call</th>
                    <th className="px-3 py-2 font-medium text-right">Last used</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map(row => {
                    const kind = KIND_STYLE[row.providerKind];
                    return (
                      <tr key={row.provider + row.model} className="border-b last:border-b-0 hover:bg-muted/30">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2 max-w-[220px]">
                            <ModelIcon modelId={row.model} />
                            <span className="font-mono text-xs text-foreground truncate" title={row.model}>
                              {row.model}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', kind.className)}>
                            {row.providerKind === 'byok' ? row.providerLabel : kind.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {row.calls}
                          {row.failedCalls > 0 && <span className="text-destructive"> ({row.failedCalls} failed)</span>}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{fmtTokens(row.inputTokens)}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{fmtTokens(row.outputTokens)}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground" title={`Cache hit rate: ${fmtPct(row.cacheHitRate)}`}>
                          {fmtTokens(row.cacheCreationTokens + row.cacheReadTokens)}
                        </td>
                        <td className="px-3 py-2 text-right text-foreground font-medium">{fmtTokens(row.totalTokens)}</td>
                        <td className="px-3 py-2 text-right text-foreground">
                          {row.unpricedCalls > 0 ? (
                            <span className="text-amber-600 dark:text-amber-400" title={`${row.unpricedCalls} call(s) had no matching price rate`}>
                              {fmtUsd(row.costUsd)} + unpriced
                            </span>
                          ) : (
                            fmtUsd(row.costUsd)
                          )}
                          {row.providerKind === 'byok' && (
                            <div className="text-[10px] text-muted-foreground leading-none mt-0.5" title="Real market rate for this model — your own key, so Entry never actually billed you for it">
                              market rate · not billed
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground text-xs">{fmtUsd(row.avgCostPerCallUsd)}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground text-xs">{fmtRelative(row.lastUsedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {data.bySource.length > 1 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-foreground">By route</span>
          <div className="border rounded-lg overflow-hidden bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Route</th>
                  <th className="px-3 py-2 font-medium text-right">Calls</th>
                  <th className="px-3 py-2 font-medium text-right">Total tokens</th>
                  <th className="px-3 py-2 font-medium text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.bySource.map(s => (
                  <tr key={s.source} className="border-b last:border-b-0">
                    <td className="px-3 py-2 font-mono text-xs text-foreground">{s.source}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{s.calls}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{fmtTokens(s.totalTokens)}</td>
                    <td className="px-3 py-2 text-right text-foreground">{fmtUsd(s.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <span className="text-xs text-muted-foreground">
        Token counts are captured verbatim from each provider's own response — never estimated. Costs use the official
        rate effective at the time of each call. "Your key" rows show the model's real market rate for reference — Entry
        never actually bills you for them.
      </span>
    </div>
  );
}
