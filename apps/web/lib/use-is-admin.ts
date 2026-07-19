'use client';

/**
 * Cheap client-side admin check for UI gating only (e.g. showing/hiding
 * the sidebar's Admin link) -- NOT a security boundary by itself. Every
 * /api/admin/* route this hook's result gates still does its own
 * session+featureService.isAdmin check server-side, so hiding the link
 * from a non-admin is pure UX; a non-admin hitting the route directly
 * still gets bounced by the real server-side check.
 * Result is cached at module scope so navigating between pages doesn't
 * re-fire the probe request every time.
 */
import { useEffect, useState } from 'react';

let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

function probe(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetch('/api/admin/users?first=1')
    .then(res => {
      cached = res.ok;
      return cached;
    })
    .catch(() => {
      cached = false;
      return false;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(cached ?? false);

  useEffect(() => {
    let cancelled = false;
    probe().then(v => { if (!cancelled) setIsAdmin(v); });
    return () => { cancelled = true; };
  }, []);

  return isAdmin;
}
