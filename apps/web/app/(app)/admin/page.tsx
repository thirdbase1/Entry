'use client';

/**
 * Admin dashboard (2026-07-19). First real UI for the /api/admin/* surface
 * that already existed as API-only routes. Deliberately only wires the
 * session+`featureService.isAdmin`-gated endpoints (users, versions) --
 * the separate ADMIN_DEBUG_TOKEN-bearer-only routes (errors, diag-sandbox,
 * diag-chat, diag-list-byok, browser-sessions) stay CLI/curl-only by
 * design, since exposing them here would mean shipping that secret to the
 * browser. Gate itself: any signed-in user can load this route, but the
 * page immediately probes GET /api/admin/users?first=1 -- a 403 means
 * "not an admin", and the whole thing just bounces back to /chats instead
 * of rendering anything.
 */
import { useCallback, useEffect, useState } from 'react';
import { AutoSidebarPadding } from '@/components/layout/auto-sidebar-padding';
import { cn } from '@/lib/utils';
import { safeJson } from '@/components/settings/shared';
import { useRouter } from 'next/navigation';

type AdminTab = 'users' | 'versions';

interface AdminUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  emailVerified: boolean;
  disabled: boolean;
  createdAt: string;
}

const ALL_FEATURES = ['administrator', 'early_access', 'unlimited_copilot', 'free_plan_v1', 'pro_plan_v1'] as const;
type FeatureKey = (typeof ALL_FEATURES)[number];

function FeatureEditor({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [features, setFeatures] = useState<Set<FeatureKey> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/users/${userId}/features`)
      .then(safeJson)
      .then(json => {
        if (cancelled) return;
        setFeatures(new Set(Array.isArray(json?.features) ? json.features : []));
      })
      .catch(() => !cancelled && setFeatures(new Set()));
    return () => { cancelled = true; };
  }, [userId]);

  const toggle = useCallback((f: FeatureKey) => {
    setFeatures(prev => {
      const next = new Set(prev ?? []);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/features`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: [...(features ?? [])] }),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || `Save failed (${res.status})`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [userId, features, onClose]);

  return (
    <div className="mt-2 mb-3 p-3 rounded border bg-accent/30 flex flex-col gap-2">
      {features === null ? (
        <div className="text-sm text-muted-foreground">Loading features…</div>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            {ALL_FEATURES.map(f => (
              <label key={f} className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input type="checkbox" checked={features.has(f)} onChange={() => toggle(f)} />
                {f}
              </label>
            ))}
          </div>
          {error ? <div className="text-sm text-destructive">{error}</div> : null}
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="text-sm px-3 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save features'}
            </button>
            <button onClick={onClose} className="text-sm px-3 py-1 rounded border">Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

function UsersSection() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [count, setCount] = useState(0);
  const [skip, setSkip] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editingFeaturesFor, setEditingFeaturesFor] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const first = 20;

  const load = useCallback(async (skipVal: number) => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/users?skip=${skipVal}&first=${first}`);
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || `Failed to load users (${res.status})`);
      setUsers(json.users ?? []);
      setCount(json.count ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(skip); }, [load, skip]);

  const toggleBan = useCallback(async (u: AdminUser) => {
    setBusyId(u.id);
    try {
      const endpoint = u.disabled ? 'enable' : 'ban';
      const res = await fetch(`/api/admin/users/${u.id}/${endpoint}`, { method: 'POST' });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || `Failed (${res.status})`);
      await load(skip);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [load, skip]);

  return (
    <div className="flex flex-col gap-3">
      {error ? <div className="text-sm text-destructive">{error}</div> : null}
      {users === null ? (
        <div className="text-sm text-muted-foreground">Loading users…</div>
      ) : (
        <>
          <div className="text-sm text-muted-foreground">{count} total users</div>
          <div className="flex flex-col divide-y border rounded">
            {users.map(u => (
              <div key={u.id} className="p-3 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{u.name || u.email}</div>
                    <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {u.disabled ? <span className="text-xs px-2 py-0.5 rounded bg-destructive/15 text-destructive">Banned</span> : null}
                    <button
                      onClick={() => setEditingFeaturesFor(prev => prev === u.id ? null : u.id)}
                      className="text-sm px-2 py-1 rounded border hover:bg-accent"
                    >
                      Features
                    </button>
                    <button
                      onClick={() => toggleBan(u)}
                      disabled={busyId === u.id}
                      className={cn(
                        'text-sm px-2 py-1 rounded border hover:bg-accent disabled:opacity-50',
                        !u.disabled && 'text-destructive'
                      )}
                    >
                      {busyId === u.id ? '…' : u.disabled ? 'Enable' : 'Ban'}
                    </button>
                  </div>
                </div>
                {editingFeaturesFor === u.id ? (
                  <FeatureEditor userId={u.id} onClose={() => setEditingFeaturesFor(null)} />
                ) : null}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSkip(s => Math.max(0, s - first))}
              disabled={skip === 0}
              className="text-sm px-3 py-1 rounded border disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => setSkip(s => s + first)}
              disabled={skip + first >= count}
              className="text-sm px-3 py-1 rounded border disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface AppVersion {
  id: string;
  label: string;
  createdAt: string;
  isLive: boolean;
}

function VersionsSection() {
  const [versions, setVersions] = useState<AppVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revertingId, setRevertingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/versions');
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || `Failed to load versions (${res.status})`);
      setVersions(json.versions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const revert = useCallback(async (v: AppVersion) => {
    if (!confirm(`Revert production to "${v.label}"? This rolls back instantly.`)) return;
    setRevertingId(v.id);
    try {
      const res = await fetch('/api/admin/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revertToId: v.id }),
      });
      const json = await safeJson(res);
      if (!res.ok) throw new Error(json?.error || `Revert failed (${res.status})`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevertingId(null);
    }
  }, [load]);

  return (
    <div className="flex flex-col gap-3">
      {error ? <div className="text-sm text-destructive">{error}</div> : null}
      {versions === null ? (
        <div className="text-sm text-muted-foreground">Loading versions…</div>
      ) : versions.length === 0 ? (
        <div className="text-sm text-muted-foreground">No versions recorded yet.</div>
      ) : (
        <div className="flex flex-col divide-y border rounded">
          {versions.map(v => (
            <div key={v.id} className="p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm flex items-center gap-2">
                  {v.isLive ? <span className="text-xs px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium">LIVE</span> : null}
                  <span className="truncate">{v.label}</span>
                </div>
                <div className="text-xs text-muted-foreground">{new Date(v.createdAt).toLocaleString()}</div>
              </div>
              {!v.isLive ? (
                <button
                  onClick={() => revert(v)}
                  disabled={revertingId === v.id}
                  className="text-sm px-2 py-1 rounded border hover:bg-accent shrink-0 disabled:opacity-50"
                >
                  {revertingId === v.id ? 'Reverting…' : 'Revert to this'}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [tab, setTab] = useState<AdminTab>('users');
  const [authorized, setAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/users?first=1')
      .then(res => {
        if (cancelled) return;
        if (res.status === 403 || res.status === 401) {
          setAuthorized(false);
          router.replace('/chats');
        } else {
          setAuthorized(true);
        }
      })
      .catch(() => !cancelled && setAuthorized(false));
    return () => { cancelled = true; };
  }, [router]);

  if (authorized !== true) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">Checking access…</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto h-full flex flex-col">
      <header className="h-15 border-b px-4 flex items-center gap-4 shrink-0">
        <AutoSidebarPadding className="transition-all h-full flex items-center">
          <span className="text-lg font-semibold text-foreground" style={{ letterSpacing: -0.24 }}>Admin</span>
        </AutoSidebarPadding>
      </header>

      <div className="max-w-3xl w-full mx-auto px-4 pt-4 shrink-0">
        <div className="flex items-center gap-1 border-b">
          <button
            onClick={() => setTab('users')}
            className={cn(
              'px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
              tab === 'users' ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Users
          </button>
          <button
            onClick={() => setTab('versions')}
            className={cn(
              'px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
              tab === 'versions' ? 'border-primary text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            Versions
          </button>
        </div>
      </div>

      <div className="max-w-3xl w-full mx-auto px-4 py-6 flex flex-col gap-4 w-full">
        {tab === 'users' ? <UsersSection /> : <VersionsSection />}
      </div>
    </div>
  );
}
