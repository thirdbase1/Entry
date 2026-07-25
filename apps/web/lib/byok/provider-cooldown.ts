/**
 * In-memory BYOK provider cooldown tracker (2026-07-25, real bug: once a
 * provider's account genuinely runs dry -- "Insufficient balance",
 * "Usage limit reached, will reset tomorrow", any permanent auth/quota
 * signal (see PERMANENT_SIGNAL_PATTERN in gateway-retry-fetch.ts) -- every
 * SUBSEQUENT turn kept re-selecting that exact same broken provider and
 * dying the exact same way, forever, until the user noticed and manually
 * switched models in Settings. The user's real complaint wasn't "why did
 * it die once" -- it was "why does the SYSTEM keep doing this instead of
 * routing around a provider it already knows is broken".
 *
 * Deliberately in-memory, not a DB column: this route runs on Pxxl as a
 * persistent long-lived process (not serverless), so a plain module-level
 * Map already survives for the life of the deployment -- exactly the
 * "persistent platform" property the account already relies on elsewhere
 * (see turn-lock.ts, model-catalog.ts's CATALOG_TTL_MS, etc). Avoids a
 * schema migration + write-amplification on every single turn just to
 * track something that only needs to survive until the next deploy.
 */

interface CooldownEntry {
  until: number;
  reason: string;
}

const COOLDOWN_MS = 15 * 60 * 1000; // 15 min -- long enough to stop hammering a dead account, short enough to self-heal once balance is topped up without needing a redeploy.

const cooldowns = new Map<string, CooldownEntry>();

/** Call when a turn's provider call ends in a known PERMANENT account-level error (see PERMANENT_SIGNAL_PATTERN). */
export function markProviderCooldown(providerId: string, reason: string): void {
  cooldowns.set(providerId, { until: Date.now() + COOLDOWN_MS, reason: reason.slice(0, 300) });
}

/** Non-mutating check -- returns the reason string if still in cooldown, or null if healthy/expired. Expired entries are pruned lazily on read. */
export function getProviderCooldown(providerId: string): string | null {
  const entry = cooldowns.get(providerId);
  if (!entry) return null;
  if (Date.now() >= entry.until) {
    cooldowns.delete(providerId);
    return null;
  }
  return entry.reason;
}

/** Debug/admin visibility only -- see diag-list-byok's sibling use. */
export function listProviderCooldowns(): Array<{ providerId: string; reason: string; secondsRemaining: number }> {
  const now = Date.now();
  const out: Array<{ providerId: string; reason: string; secondsRemaining: number }> = [];
  for (const [providerId, entry] of cooldowns.entries()) {
    if (now >= entry.until) {
      cooldowns.delete(providerId);
      continue;
    }
    out.push({ providerId, reason: entry.reason, secondsRemaining: Math.round((entry.until - now) / 1000) });
  }
  return out;
}
