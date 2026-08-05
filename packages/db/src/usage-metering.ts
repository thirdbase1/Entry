/**
 * Usage metering (Phase 1 of admin.md §2, 2026-07-19).
 *
 * One function, one job: persist a UsageEvent row for every AI model call,
 * priced against the ModelPriceRate table. Design rules (from admin.md):
 *
 * - CAPTURE, DON'T ESTIMATE: token counts come verbatim from the
 *   provider's `usage` object. If a caller has no usage data it should
 *   not call this at all (that absence is itself logged by the caller).
 * - Rate lookup is "latest rate whose effectiveFrom <= event time" with a
 *   prefix match on the model id (gateway ids look like
 *   "anthropic/claude-sonnet-4-5"; the bare id must match the same row) --
 *   so a vendor price change NEVER retroactively reprices history.
 * - No matching rate => the row is written with faceValueUsd 0 AND
 *   priceRateId null. That null is the "UNPRICED" alarm the admin Billing
 *   tab surfaces -- an unpriced event must never silently become a $0 bill.
 * - NEVER throws. Metering must not be able to take down a chat turn --
 *   failures log and return null. (Same philosophy as safeExecute on
 *   tool calls: instrumentation is not allowed to become the outage.)
 * - BYOK calls (user's own key) always get actualCostUsd 0 -- they cost
 *   us nothing and will never burn credits -- but faceValueUsd is STILL
 *   priced against the rate table like any other call, purely
 *   informational ("what would this have cost"), so per-user usage
 *   analytics show a real $ figure instead of a hardcoded free/$0
 *   ("nothing left out").
 */
import { prisma } from './db';

export interface UsageTokens {
  inputTokens?: number;
  outputTokens?: number;
  /** Anthropic cache_creation_input_tokens (via AI SDK providerMetadata) */
  cacheCreationTokens?: number;
  /** Anthropic cache_read_input_tokens */
  cacheReadTokens?: number;
}

export interface RecordUsageArgs {
  userId: string;
  chatId?: string;
  /** Which code path served this: "direct-chat" | "eve-root" | ... */
  source: string;
  /** Model id as the call site knows it, e.g. "anthropic/claude-sonnet-4-5". */
  model: string;
  /** "gateway" | "byok:<providerLabel>" | future AIProviderRoute ids. */
  provider: string;
  usage: UsageTokens;
  /**
   * Cost the provider itself reported for this exact call (e.g. Vercel AI
   * Gateway's providerMetadata.gateway.cost). When present this IS the
   * face value -- more authoritative than our own rate-table math, since
   * the provider bills us off this number. Rate lookup is skipped.
   */
  providerReportedCostUsd?: number;
  finishReason?: string;
  success?: boolean;
}

/** True when the call ran on the user's own key -- costs us nothing. */
export function isByok(provider: string): boolean {
  return provider.startsWith('byok:');
}

/** True for a platform-provided ("shared") relay key -- unlike BYOK this
 *  DOES cost the platform real money, so it's priced normally (never
 *  zeroed) and is subject to its own per-provider spend cap. */
function isShared(provider: string): boolean {
  return provider.startsWith('shared:');
}

/**
 * Cumulative real spend (USD) against ONE specific shared provider row for
 * the CURRENT CALENDAR MONTH, summed straight from the ledger -- never a
 * separate running counter that could drift from the source of truth. Used
 * as a pre-flight gate (see direct/chat/route.ts) so a capped shared
 * provider can never be called again once its cap is hit for the month.
 *
 * SCOPED TO CALENDAR MONTH (2026-07-26, owner ask: "the $20 usage should
 * reset every [month] on the 1st"): originally this summed ALL-TIME spend,
 * so a shared relay (e.g. HCNSec) would stay permanently locked out once
 * it ever crossed its cap, with no way to recover short of manually raising
 * spendCapUsd. Anchoring the SUM to `created_date >= start of this month`
 * means the gate naturally re-opens at 00:00 on the 1st of every month --
 * no cron job or reset job needed, since it's still a live query over the
 * ledger, just windowed.
 */
export async function getProviderSpendUsd(providerId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const result = await prisma.usageEvent.aggregate({
    where: { provider: `shared:${providerId}`, createdAt: { gte: startOfMonth } },
    _sum: { actualCostUsd: true },
  });
  return Number(result._sum.actualCostUsd ?? 0);
}

/**
 * ONE COMBINED POOL ACROSS ALL SHARED PROVIDERS, PER USER (owner ask
 * 2026-07-27: "the $20 usage is for only hcnsec model, do it to be for
 * both free and hcnsec" -- HCNSec, freemodel.dev, and now Opencode Zen
 * must draw down the SAME single monthly budget instead of each having
 * its own separate cap). Renamed user-facing label is "Monthly usage"
 * everywhere (route.ts's gate error message + the Settings > Usage
 * card) -- this constant is now the ONE source of truth for that cap,
 * not each UserModelProvider row's own `spendCapUsd` column (kept
 * populated for informational/legacy display only, no longer read for
 * enforcement).
 *
 * DECREASED to $10 (owner ask, same message: "decrease usage to $10").
 *
 * FIXED (2026-07-27, real bug the owner caught live): this was a single
 * PLATFORM-WIDE pool with zero userId scoping -- getAllSharedSpendUsd()
 * summed every user's usageEvent rows together, so one heavy user could
 * exhaust the $10 cap for every other account on the platform. That is
 * NOT what "$10 monthly usage" was ever supposed to mean -- each account
 * gets its own independent $10/mo budget. getAllSharedSpendUsd now
 * requires a userId and filters on it; there is no more all-accounts
 * variant.
 */
export const SHARED_MONTHLY_CAP_USD = 10;

/** Same "live SUM over the ledger, current calendar month" shape as
 *  getProviderSpendUsd above, but across EVERY isShared provider's usage
 *  combined (`provider LIKE 'shared:%'`) for ONE user -- this is what
 *  actually gates and displays that user's own "Monthly usage" cap.
 *  Scoped by userId (fixed 2026-07-27 -- see constant comment above for
 *  why an unscoped, all-accounts sum was a real bug, not the design). */
export async function getAllSharedSpendUsd(userId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const result = await prisma.usageEvent.aggregate({
    where: { userId, provider: { startsWith: 'shared:' }, createdAt: { gte: startOfMonth } },
    _sum: { actualCostUsd: true },
  });
  return Number(result._sum.actualCostUsd ?? 0);
}

/**
 * Latest rate row effective at `at` whose modelPattern matches `model`.
 * Comparison is done on the segment after the last "/" so
 * "claude-sonnet-4-5" converges with an "anthropic/claude-sonnet-4-5"
 * pattern either direction.
 *
 * FIXED (owner report 2026-07-26: claude-opus-4-6 billed at $32.07 for
 * ~1.6M tokens -- roughly 3x what its own seeded rate could ever produce
 * even in the worst case). Root cause: this used to do
 * `bareModel === barePattern || bareModel.startsWith(barePattern)` inside
 * a single `.find()` over candidates sorted ONLY by `effectiveFrom desc`
 * -- meaning a SHORTER, unrelated pattern that merely happens to be a
 * string-prefix of the real model id (e.g. a generic "claude-opus-4"
 * fallback row is a prefix of "claude-opus-4-6") could win over the
 * correct EXACT match, purely because it happened to have a more recent
 * `effectiveFrom` timestamp and `.find()` stops at the first hit
 * regardless of match quality. An exact match must always outrank a
 * loose prefix match -- ordering by recency should only ever be a
 * tiebreaker WITHIN the same match tier, never a way for a worse match
 * to shadow a better one. Now: collect exact matches and prefix matches
 * separately, always prefer the most recent EXACT match, and only fall
 * back to the most recent prefix match if no exact match exists at all.
 */
/**
 * Pure matcher, no DB access -- extracted (2026-07-26) so callers that need
 * to price MANY rows in one request (e.g. the admin backfill route) can
 * fetch the ModelPriceRate table ONCE and reuse it, instead of re-querying
 * per row. findRateForModel() below re-queries every call, which is fine
 * for single live pricing calls but was causing the backfill route to do
 * ~714 sequential DB round-trips for 357 rows -- routinely blowing past
 * Cloudflare's 120s proxy timeout (520 error) before finishing.
 */
export function matchRateFromCandidates<T extends { modelPattern: string }>(
  candidates: T[],
  model: string
): T | null {
  const bareModel = model.split('/').pop() ?? model;
  const exact = candidates.find(rate => {
    const barePattern = rate.modelPattern.split('/').pop() ?? rate.modelPattern;
    return bareModel === barePattern;
  });
  if (exact) return exact;
  return (
    candidates.find(rate => {
      const barePattern = rate.modelPattern.split('/').pop() ?? rate.modelPattern;
      return bareModel.startsWith(barePattern);
    }) ?? null
  );
}

export async function findRateForModel(model: string, at: Date) {
  const candidates = await prisma.modelPriceRate.findMany({
    where: { effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
  return matchRateFromCandidates(candidates, model);
}

/** Per-million-token pricing applied to the four token buckets. */
export function priceUsage(
  usage: UsageTokens,
  rate: { inputPerMTok: unknown; outputPerMTok: unknown; cacheWritePerMTok: unknown; cacheReadPerMTok: unknown }
): number {
  const perTok = (perM: unknown) => Number(perM) / 1_000_000;
  return (
    (usage.inputTokens ?? 0) * perTok(rate.inputPerMTok) +
    (usage.outputTokens ?? 0) * perTok(rate.outputPerMTok) +
    (usage.cacheCreationTokens ?? 0) * perTok(rate.cacheWritePerMTok) +
    (usage.cacheReadTokens ?? 0) * perTok(rate.cacheReadPerMTok)
  );
}

/**
 * Write one UsageEvent row. Never throws; returns the created row id or
 * null on failure. Fire-and-forget friendly (callers on the hot streaming
 * path should NOT await this serially -- pass it to waitUntil()/after()).
 */
export async function recordUsageEvent(args: RecordUsageArgs): Promise<string | null> {
  try {
    const now = new Date();
    const byok = isByok(args.provider);
    const reported = args.providerReportedCostUsd;
    const hasReportedCost = typeof reported === 'number' && Number.isFinite(reported) && reported >= 0;
    // BYOK: user's own key, costs US ($0 -- actualCostUsd below stays 0
    // regardless) -- but we STILL look up a market rate for faceValueUsd
    // (owner ask 2026-07-26: "why don't you show the price" -- BYOK usage
    // should still show what the call would have cost at the model's real
    // published rate, purely informational, even though Entry pays $0 for
    // it). Provider-reported cost (e.g. Gateway's own metadata.cost) is
    // still authoritative when present -- skips the rate table either way.
    const rate = hasReportedCost ? null : await findRateForModel(args.model, now);
    const faceValueUsd = hasReportedCost ? reported : rate ? priceUsage(args.usage, rate) : 0;
    const row = await prisma.usageEvent.create({
      data: {
        userId: args.userId,
        chatId: args.chatId,
        source: args.source,
        model: args.model,
        provider: args.provider,
        inputTokens: args.usage.inputTokens ?? 0,
        outputTokens: args.usage.outputTokens ?? 0,
        cacheCreationTokens: args.usage.cacheCreationTokens ?? 0,
        cacheReadTokens: args.usage.cacheReadTokens ?? 0,
        faceValueUsd,
        // Single implicit route at 1.0x until the multi-key router lands
        // (admin.md §4) -- actual == face for gateway calls, 0 for BYOK.
        actualCostUsd: byok ? 0 : faceValueUsd,
        // 'provider-reported' sentinel = priced by the provider's own cost
        // figure, not our rate table (column has no FK, safe). null still
        // means UNPRICED -- the admin Billing tab's alarm state.
        priceRateId: hasReportedCost ? 'provider-reported' : (rate?.id ?? null),
        finishReason: args.finishReason,
        success: args.success ?? true,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    // Metering must never break a chat turn. Log and move on.
    console.error('[usage-metering] failed to record usage event', {
      userId: args.userId,
      model: args.model,
      source: args.source,
      err,
    });
    return null;
  }
}
