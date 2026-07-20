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
 * - BYOK calls (user's own key) are recorded with both cost fields 0 --
 *   they cost us nothing and will never burn credits, but they still show
 *   in per-user usage analytics ("nothing left out").
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
  finishReason?: string;
  success?: boolean;
}

/** True when the call ran on the user's own key -- costs us nothing. */
function isByok(provider: string): boolean {
  return provider.startsWith('byok:');
}

/**
 * Latest rate row effective at `at` whose modelPattern prefix-matches
 * `model` (either direction: "claude-sonnet-4-5" must hit a
 * "anthropic/claude-sonnet-4-5" pattern and vice versa -- comparison is
 * done on the segment after the last "/" so both spellings converge).
 */
export async function findRateForModel(model: string, at: Date) {
  const bareModel = model.split('/').pop() ?? model;
  const candidates = await prisma.modelPriceRate.findMany({
    where: { effectiveFrom: { lte: at } },
    orderBy: { effectiveFrom: 'desc' },
  });
  return (
    candidates.find(rate => {
      const barePattern = rate.modelPattern.split('/').pop() ?? rate.modelPattern;
      return bareModel === barePattern || bareModel.startsWith(barePattern);
    }) ?? null
  );
}

/** Per-million-token pricing applied to the four token buckets. */
function priceUsage(
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
    // BYOK: user's own key, costs us $0 -- skip the rate lookup entirely.
    const rate = byok ? null : await findRateForModel(args.model, now);
    const faceValueUsd = rate ? priceUsage(args.usage, rate) : 0;
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
        priceRateId: rate?.id ?? null,
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
