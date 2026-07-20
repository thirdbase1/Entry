import { defineHook } from 'eve/hooks';
import { recordUsageEvent } from '@entry/db/usage-metering';
import { resolveModelIdForProvider } from '../lib/model-catalog.js';

/**
 * Usage metering for the eve-default chat path (Phase 1 of admin.md §2).
 *
 * The direct/BYOK path meters inside its own route handler
 * (apps/web/app/api/direct/chat/route.ts); this hook is the equivalent for
 * every turn that runs through eve's session runtime instead. Subscribes
 * to `step.completed` -- eve emits exactly one per model call, tool-loop
 * steps included, and its `data.usage` is extracted from the same AI SDK
 * usage object the model actually returned (see eve's
 * harness/step-hooks.js extractStepUsage) -- captured, never estimated,
 * per admin.md §2.1. Per-STEP metering also means a turn hard-killed
 * mid-run still has every completed step's tokens on record; only the
 * step that died is lost, which is the floor of what's knowable.
 *
 * `step.failed` is deliberately NOT metered: eve's failed-step event
 * carries no usage payload at all (code/message only, see
 * protocol/message.d.ts), and the failed call's *predecessor* steps were
 * already recorded individually as they completed.
 *
 * Cost: eve forwards Vercel AI Gateway's own per-call `cost` figure as
 * `usage.costUsd` when the Gateway reports one. That number is what
 * Gateway actually bills us, so it's passed through as
 * providerReportedCostUsd and wins over our rate-table math. If it's
 * absent (e.g. an anthropic-direct route someday), recordUsageEvent
 * falls back to the ModelPriceRate table.
 *
 * Token buckets: eve's `usage.inputTokens` is the AI SDK TOTAL (cached
 * included); cacheRead/cacheWrite are broken out alongside. The
 * non-cached portion for input-rate pricing is total minus both cache
 * buckets, clamped at 0 -- same accounting the direct-chat path does via
 * inputTokenDetails.noCacheTokens.
 *
 * BYOK turns never reach eve's runtime at all (intercepted in
 * apps/web/middleware.ts before the session runtime -- see agent.ts's
 * model comment), so provider here is always the shared Gateway path.
 *
 * Same philosophy as recordUsageEvent itself: metering must never become
 * the outage. Everything is wrapped; a failure logs and the turn is
 * untouched.
 */
export default defineHook({
  events: {
    'step.completed': async (event, ctx) => {
      try {
        const auth = ctx.session.auth;
        const userId = auth.current?.principalId ?? auth.initiator?.principalId;
        if (!userId) return; // system/schedule-driven step: no one to bill

        const usage = event.data.usage;
        if (!usage) {
          // admin.md §2.1: a model response with no usage block is an
          // alarm, not a silent skip -- something upstream changed shape.
          console.warn('[usage-metering hook] step.completed with no usage payload', {
            sessionId: ctx.session.id,
            turnId: event.data.turnId,
            stepIndex: event.data.stepIndex,
          });
          return;
        }

        // Root agent's model id is resolved from the live Gateway catalog
        // (cached ~5min in model-catalog.ts); the step event itself does
        // not carry a model id. If the catalog is unreachable right now,
        // still record the row -- Gateway's costUsd keeps the $ figure
        // exact even when the model label degrades to unknown.
        const model = await resolveModelIdForProvider('anthropic').catch(() => 'anthropic/unknown');

        const total = usage.inputTokens ?? 0;
        const cacheRead = usage.cacheReadTokens ?? 0;
        const cacheWrite = usage.cacheWriteTokens ?? 0;

        await recordUsageEvent({
          userId,
          chatId: ctx.session.id,
          // Child sessions spawned by the `agent` delegate tool bill to
          // the same user but are worth telling apart in analytics.
          source: ctx.session.parent ? 'eve-subagent' : 'eve-root',
          model,
          provider: 'gateway',
          usage: {
            inputTokens: Math.max(0, total - cacheRead - cacheWrite),
            outputTokens: usage.outputTokens ?? 0,
            cacheCreationTokens: cacheWrite,
            cacheReadTokens: cacheRead,
          },
          providerReportedCostUsd: usage.costUsd,
          finishReason: event.data.finishReason,
        });
      } catch (err) {
        console.error('[usage-metering hook] failed', ctx.session.id, err);
      }
    },
  },
});
