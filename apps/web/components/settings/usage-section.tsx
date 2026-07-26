'use client';

/**
 * Personal "Usage" tab (owner ask 2026-07-26): every model the user has
 * actually called — gateway, BYOK, and the platform's shared relay keys —
 * with an accurate token + cost breakdown, split by today / this month /
 * all time. Reads /api/user/usage/summary, which itself reads straight
 * off the UsageEvent ledger (never estimated — see that route's file
 * comment). Polls every 30s so it stays live while a chat is running,
 * without being so aggressive it hammers the DB.
 */
import { useEffect, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';

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
  unpricedCalls: number;
  failedCalls: number;
  lastUsedAt: string;
  spendCapUsd: number | null;
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
  byModel: ModelRow[];
  sharedProviders: SharedProviderCap[];
  generatedAt: string;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
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
      {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
    </div>
  );
}

export function UsageSection() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/user/usage/summary', { cache: 'no-store' });
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
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Today" value={fmtUsd(data.today.costUsd)} sub={`${fmtTokens(data.today.totalTokens)} tokens · ${data.today.calls} calls`} />
        <StatCard label="This month" value={fmtUsd(data.month.costUsd)} sub={`${fmtTokens(data.month.totalTokens)} tokens · ${data.month.calls} calls`} />
        <StatCard label="All time spend" value={fmtUsd(data.allTime.costUsd)} sub={`${data.allTime.calls} calls total`} />
        <StatCard label="All time tokens" value={fmtTokens(data.allTime.totalTokens)} sub={`${fmtTokens(data.allTime.inputTokens)} in · ${fmtTokens(data.allTime.outputTokens)} out`} />
      </div>

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
                    <th className="px-3 py-2 font-medium text-right">Last used</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map(row => {
                    const kind = KIND_STYLE[row.providerKind];
                    return (
                      <tr key={row.provider + row.model} className="border-b last:border-b-0 hover:bg-muted/30">
                        <td className="px-3 py-2 font-mono text-xs text-foreground truncate max-w-[220px]" title={row.model}>
                          {row.model}
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
                        <td className="px-3 py-2 text-right text-muted-foreground">{fmtTokens(row.cacheCreationTokens + row.cacheReadTokens)}</td>
                        <td className="px-3 py-2 text-right text-foreground font-medium">{fmtTokens(row.totalTokens)}</td>
                        <td className="px-3 py-2 text-right text-foreground">
                          {row.providerKind === 'byok' ? (
                            <span className="text-muted-foreground">free (your key)</span>
                          ) : row.unpricedCalls > 0 ? (
                            <span className="text-amber-600 dark:text-amber-400" title={`${row.unpricedCalls} call(s) had no matching price rate`}>
                              {fmtUsd(row.costUsd)} + unpriced
                            </span>
                          ) : (
                            fmtUsd(row.costUsd)
                          )}
                        </td>
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

      <span className="text-xs text-muted-foreground">
        Token counts are captured verbatim from each provider's own response — never estimated. Costs use the official
        rate effective at the time of each call. "Your key" rows never cost Entry anything and always show as free.
      </span>
    </div>
  );
}
