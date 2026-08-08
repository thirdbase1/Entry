/**
 * Direct-model chat turn -- the ONLY path for a chat where the user
 * explicitly picked a model in the selector, whether one of their own
 * BYOK provider models (`byokModelId`) or a Vercel AI Gateway model
 * (`requestedModel`).
 *
 * MIGRATED (2026-08-07) to start a durable turn-workflow.ts run instead of
 * calling streamText() directly in this handler -- see turn-workflow.ts's
 * file header for the full "why": this route's own function invocation is
 * still Vercel-capped at 300s same as always, but starting a workflow run
 * and streaming FROM it has no such cap on the run's own total duration.
 * This handler is now genuinely thin: auth, parse, sanitize, the
 * concurrency guard, preSave, and model resolution (needed up front for
 * the one-time UIMessage->ModelMessage conversion + relay-flag detection)
 * -- then it hands off to the workflow and streams its native output
 * straight through. Everything else (the actual model+tool loop, onFinish/
 * onError/prepareStep, per-step persistence, version capture) now lives in
 * turn-workflow.ts, unchanged in substance from this file's old inline
 * version, just re-homed so it can run across as many workflow steps as a
 * turn actually needs.
 */
import { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/api-error';

import { convertToModelMessages, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { start, getRun } from 'workflow/api';
import { getUserSessionFromRequest } from '@entry/auth';
import { prisma } from '@entry/db';
import { logError } from '@entry/db/error-log';
import { getAllSharedSpendUsd, SHARED_MONTHLY_CAP_USD } from '@entry/db/usage-metering';
import { resolveByokModel, pickFallbackByokModel } from '@/lib/byok/resolve-model';
import { getProviderCooldown } from '@/lib/byok/provider-cooldown';
import { resolveGatewayModel } from '@/lib/direct-chat/resolve-gateway-model';
import { resolveModelIdForProvider } from '@entry/agent/lib/model-catalog';
import { isGatewayModelReasoningCapable } from '@/lib/direct-chat/reasoning-capability';
import { sanitizeDanglingToolCalls } from '@/lib/direct-chat/sanitize-messages';
import { mergeAndPersistChatEvents } from '@/lib/direct-chat/persist-chat-events';
import { stripReasoningParts } from '@/lib/direct-chat/strip-reasoning-parts';
import { applyConversationCacheControl } from '@/lib/direct-chat/prompt-cache';
import { runDirectChatTurnWorkflow } from '@/lib/direct-chat/turn-workflow';

export const maxDuration = 300;

/**
 * HARD RESPONSE DEADLINE (added 2026-08-08, live bug: "message doesn't
 * get to agent"). Reproduced directly against production: a real POST
 * here uploaded fully, then got ZERO response bytes and no HTTP status at
 * all until the client gave up -- and nothing about that request showed
 * up in server logs either, meaning whatever hung did so before any of
 * this handler's own log lines ever ran. Everything before the workflow
 * actually starts streaming (auth lookup, the concurrency-guard read,
 * `start()` itself) is plain `await`ed with no bound of its own -- a
 * stuck DB connection-pool acquire or a slow `start()` call against the
 * Workflow orchestrator had no ceiling and would hang the whole request
 * forever, leaving the user staring at nothing with no error, no retry,
 * no explanation. `sendWithRetry` client-side and the 30s recovery-poll
 * give-up both assume SOME response eventually comes back -- neither
 * covers a request that never resolves at all. This wraps that
 * unbounded prefix in a deadline so the absolute worst case is now a
 * clean, fast, retryable error instead of an infinite silent hang.
 */
const PRE_STREAM_DEADLINE_MS = 25_000;
class PreStreamTimeoutError extends Error {}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new PreStreamTimeoutError(`[direct chat] "${label}" exceeded ${PRE_STREAM_DEADLINE_MS}ms deadline`)), PRE_STREAM_DEADLINE_MS),
    ),
  ]);
}

export const POST = withApiErrorHandling(async (req: NextRequest) => {
  console.log('[direct chat] request received', { at: new Date().toISOString() });
  try {
    return await handleDirectChatPost(req);
  } catch (err) {
    if (err instanceof PreStreamTimeoutError) {
      console.error('[direct chat] pre-stream deadline hit -- returning error instead of hanging forever', err.message);
      return Response.json(
        { error: "Couldn't reach the server in time -- please try sending that again." },
        { status: 503 },
      );
    }
    throw err;
  }
});

async function handleDirectChatPost(req: NextRequest) {
  console.error('[direct-chat-diag] before auth session lookup', new Date().toISOString());
  const { session } = await withDeadline(getUserSessionFromRequest(req), 'auth session lookup');
  console.error('[direct-chat-diag] after auth session lookup', new Date().toISOString());
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const body = await req.json().catch(() => ({}));
  console.error('[direct-chat-diag] after body parse', new Date().toISOString());
  const { id, messages, byokModelId, requestedModel, disabledTools } = body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'messages is required' }, { status: 400 });
  }
  const uiMessages = sanitizeDanglingToolCalls(messages as UIMessage[]);


  // chatId computed here (pure/sync, no await needed) so the working-memory
  // fetch right below can be keyed by IT instead of userId -- see
  // working-memory.ts's 2026-07-23 comment: this note is per-CHAT now, not
  // per-user, so it must never be fetched before we know which chat this is.
  const chatId = typeof id === 'string' && id ? id : crypto.randomUUID();

  // CONCURRENCY GUARD (2026-08-07 migration off the Redis turn-lock --
  // see turn-workflow.ts's file header for the full "why" on this whole
  // migration). A chat's own row now carries its live workflow run id
  // (reusing the existing `cursor` JSONB column -- see schema comment,
  // "eve rows only" is stale now that direct-chat rows use it too) --
  // checking THAT run's own status via getRun() is a direct, authoritative
  // answer to "is a turn already in flight for this chat", no separate
  // lock primitive/heartbeat/TTL needed at all: a workflow run's status
  // IS its own liveness signal, durably tracked by the platform itself.
  console.error('[direct-chat-diag] before concurrency-guard DB read', new Date().toISOString());
  const existingRow = await withDeadline(
    prisma.eveChatSession.findFirst({ where: { id: chatId, userId }, select: { cursor: true } }),
    'concurrency-guard DB read',
  );
  console.error('[direct-chat-diag] after concurrency-guard DB read', new Date().toISOString());
  const existingRunId = existingRow?.cursor && typeof existingRow.cursor === 'object' && 'workflowRunId' in existingRow.cursor
    ? (existingRow.cursor as { workflowRunId?: string }).workflowRunId
    : undefined;
  if (existingRunId) {
    try {
      const existingRun = getRun(existingRunId);
      const status = await existingRun.status;
      if (status === 'pending' || status === 'running') {
        return Response.json(
          { error: 'turn_in_progress', chatId, message: 'Still working on your last message in this chat.' },
          { status: 409 }
        );
      }
    } catch {
      // Run genuinely gone (expired/never existed) -- fall through and
      // start a fresh one, same as if cursor had never been set.
    }
  }

  // BYOK TTFT FIX (2026-07-19): resolving a BYOK model reads/decrypts its
  // provider row, while Working Memory is a completely independent read.
  // Starting the latter only AFTER `await resolveByokModel()` made every
  // direct/BYOK send pay those two DB operations serially before
  // `streamText()` could open the provider connection. Started as soon as
  // chatId exists; it is still awaited before the system prompt is built,
  // so neither prompt contents nor error behavior changes -- only the
  // otherwise-wasted wall-clock overlap does.
  // FIXED (2026-07-21, real confirmed bug -- reported as "chat doesn't
  // create/save in the DB" and independently traced through actual
  // production DB rows: the user's most recent chats before this fix
  // stopped dead at whatever day BYOK model resolution started failing
  // for them, with NOTHING newer ever persisted). preSave (below,
  // unchanged) used to be defined and invoked only AFTER `await
  // resolveByokModel(...)` -- since resolveByokModel can throw (unknown/
  // disabled/not-owned model id, a stale client-side model selection
  // pointing at a model that got disabled after a past failed test, or a
  // decrypt failure from a rotated encryption key), and a thrown error
  // from an earlier `await` in a straight-line async function skips every
  // line textually after it, ANY resolution failure meant preSave was
  // simply never reached at all -- the user's own message vanished with
  // zero trace, no row, nothing to recover, even though the whole POINT
  // of preSave's design (see its own comment below) was to guarantee the
  // user's message is never lost even when the model call itself fails.
  // Moving chatId + preSave up here (their only dependencies -- uiMessages,
  // byokModelId, requestedModel, chatId itself -- are all already
  // available at this point) means the row now always gets created/
  // updated with the user's turn REGARDLESS of whether model resolution
  // below succeeds, fails, or hangs. resolveByokModel is wrapped below so
  // a throw there still lets preSave finish before the error response
  // goes out, instead of racing an unhandled rejection.
  const preSave = (async () => {
    const existing = await prisma.eveChatSession.findFirst({ where: { id: chatId, userId }, select: { events: true } });
    if (!existing) {
      const firstUserTextPart = uiMessages.find(m => m.role === 'user')?.parts?.find((p: any) => p.type === 'text') as { text?: string } | undefined;
      const firstUserText = firstUserTextPart?.text ?? '';
      await prisma.eveChatSession.create({
        data: {
          id: chatId,
          userId,
          byokModelId: byokModelId ?? null,
          requestedModel: byokModelId ? null : requestedModel,
          title: firstUserText.slice(0, 80) || null,
          events: uiMessages as any,
        },
      });
    } else {
      // RACE-SAFE (2026-07-23, see persist-chat-events.ts's file comment
      // for the full "some model response disappeared forever" bug this
      // closes): used to be a blind `update({ data: { events: uiMessages } })`
      // -- a full-column overwrite using ONLY this request's own client-
      // sent snapshot, with no idea whether a concurrent turn on the same
      // chatId had already committed something newer. `existing.events`
      // (this row's actual last-known-good state, fetched a moment ago)
      // is the baseline; mergeAndPersistChatEvents re-checks that baseline
      // against the row's truly-current state inside a row lock right
      // before writing, and appends only what THIS request's client view
      // has beyond that baseline (normally just the one new user message)
      // instead of clobbering anything committed in between.
      const existingEvents = Array.isArray(existing.events) ? (existing.events as unknown[]) : [];
      await mergeAndPersistChatEvents(chatId, userId, existingEvents, uiMessages, {
        byokModelId: byokModelId ?? null,
        requestedModel: byokModelId ? null : (requestedModel ?? null),
      });
    }
  })().catch(err => {
    console.error('[direct chat] pre-stream save failed', chatId, err);
    logError({ source: 'direct-chat-presave', error: err, userId, chatId });
  });


  // Resolve BEFORE any streaming starts — a bad/missing key or unknown
  // model slug surfaces as a clean JSON error, not a broken half-open
  // stream. Wrapped so preSave (already running concurrently above) is
  // always awaited before a resolution failure's error response goes out
  // -- the user's message is now guaranteed saved even on this path.
  let resolved: Awaited<ReturnType<typeof resolveByokModel>> | ReturnType<typeof resolveGatewayModel>;
  // Plain 'in' narrowing on this union degrades to an unhelpful intersection type
  // (ResolvedGatewayModel has no providerId field at all, not even optional) --
  // an explicit type guard narrows cleanly instead.
  const isByokResolved = (r: typeof resolved): r is Awaited<ReturnType<typeof resolveByokModel>> => 'providerId' in r;
  // SURFACED TO THE USER (2026-07-27, real report: "I selected a BYOK
  // model but the chat used HCNSec deepseek instead" -- root cause was
  // THIS exact cooldown-fallback substitution firing silently: a provider
  // in cooldown gets swapped for a different one server-side with only a
  // console.warn, nothing visible in the UI at all, so a substitution
  // reads indistinguishable from "the picker is broken/ignored". Kept
  // outside the try block so it survives into messageMetadata below
  // regardless of which branch resolved things.
  let substitutionNotice: string | null = null;
  try {
    resolved = byokModelId
      ? await resolveByokModel(byokModelId, userId)
      : requestedModel
        ? resolveGatewayModel(requestedModel)
        : resolveGatewayModel(await resolveModelIdForProvider('anthropic'));

    // FALLBACK ON COOLDOWN (2026-07-25, see provider-cooldown.ts's file
    // comment for the incident this fixes): a BYOK provider whose account
    // just hit a permanent error (insufficient balance, quota exhausted,
    // etc) stays in cooldown for 15 minutes. Re-selecting a model on that
    // exact same account every single turn just reproduces the identical
    // dead-on-arrival failure -- so if the resolved model's provider is
    // currently in cooldown, transparently substitute the best other
    // enabled model (different provider preferred) BEFORE any streaming
    // starts, instead of letting the turn die the same way again.
    if (isByokResolved(resolved)) {
      const cooldownReason = getProviderCooldown(resolved.providerId);
      if (cooldownReason) {
        const fallbackId = await pickFallbackByokModel(userId, resolved.providerId);
        if (fallbackId && fallbackId !== resolved.byokModelId) {
          // MODEL NAME ONLY (2026-07-27, owner ask: "only show the model
          // name, remove that word route/routing, don't show the
          // provider") -- this notice used to name the internal relay
          // ("HCNSec Relay", "freemodel.dev") on both sides of the swap,
          // exactly the provider-label leak the owner asked to remove
          // from the model picker. Uses each side's bare model id
          // instead, same as the picker itself does for shared rows.
          const deadModelLabel = resolved.modelId;
          const deadProviderLabel = resolved.providerLabel;
          console.warn('[direct chat] provider in cooldown, substituting fallback model', {
            chatId,
            deadProvider: deadProviderLabel,
            deadModel: deadModelLabel,
            cooldownReason,
            fallbackByokModelId: fallbackId,
          });
          resolved = await resolveByokModel(fallbackId, userId);
          substitutionNotice = `"${deadModelLabel}" is temporarily unavailable — used "${resolved.modelId}" for this reply instead.`;
        }
      }
    }
  } catch (err) {
    await preSave;
    throw err;
  }

  // MONTHLY USAGE CAP -- ONE COMBINED POOL ACROSS EVERY SHARED PROVIDER,
  // PER ACCOUNT (2026-07-27, owner ask: "the $20 usage is for only
  // hcnsec, do it to be for both free and hcnsec" + "decrease usage to
  // $10" + "change that place name to monthly usage"). Any
  // platform-provided relay (HCNSec, freemodel.dev, Opencode Zen, ...)
  // now draws against the SAME single monthly budget instead of each
  // having its own separate cap -- so hitting the cap on one shared
  // model blocks ALL shared models for THIS ACCOUNT until the calendar
  // month rolls over, not just that one model.
  //
  // FIXED (2026-07-27, real bug the owner caught live): this used to sum
  // spend across EVERY account on the platform, so one heavy user could
  // exhaust the shared budget for every other account. Each account gets
  // its own independent $10/mo pool -- getAllSharedSpendUsd is scoped to
  // `userId` now, see its own comment in usage-metering.ts.
  //
  // Checked here -- AFTER resolution/cooldown-fallback, BEFORE any
  // streaming starts -- so a request that would push spend over the cap
  // is rejected cleanly up front instead of after already burning
  // tokens. Read fresh from the ledger every turn (never a separate
  // counter that could drift): see getAllSharedSpendUsd's own comment
  // for why it's a live SUM over UsageEvent, not a cached running total.
  if (isByokResolved(resolved) && resolved.isShared) {
    const spentSoFar = await getAllSharedSpendUsd(userId);
    if (spentSoFar >= SHARED_MONTHLY_CAP_USD) {
      await preSave;
        throw new Error(
        `Your monthly usage budget is exhausted ($${spentSoFar.toFixed(2)} of $${SHARED_MONTHLY_CAP_USD.toFixed(2)} spent across all free/shared models) — pick a BYOK (your own key) model, or wait for next month's reset.`
      );
    }
  }

  const { model, providerLabel, modelId } = resolved;

  // THINKING/REASONING WIRING (2026-07-25, confirmed live bug): the AI
  // SDK's 'reasoning' call option only actually enables a provider's
  // extended-thinking mode when given a real effort value ('low' /
  // 'medium' / 'high' / etc) -- see @ai-sdk/provider-utils's own
  // isCustomReasoning(), which explicitly excludes 'provider-default'
  // from ever being translated into Anthropic's `thinking` param (or
  // Google's `thinkingConfig`, or OpenAI's `reasoning_effort`). Passing
  // 'provider-default' unconditionally (as this route always did since
  // the 2026-07-15 removal of the old per-message effort picker) means
  // NONE of those providers' real thinking params are EVER sent,
  // regardless of the settings page's per-model "Thinking" toggle --
  // confirmed directly against a real captured freemodel.dev request
  // body (Claude Opus 5, BYOK), which had no `thinking` field at all.
  // That toggle (`reasoningEnabled` on a BYOK model row) was being
  // persisted and shown as on in the UI, but had zero effect server-
  // side. Fixed by actually branching on it: a real effort level is only
  // sent when the user opted in (BYOK's per-model toggle) or the
  // resolved Gateway model is confirmed reasoning-capable (no per-model
  // toggle exists there -- see reasoning-capability.ts, which already
  // fails closed to `false` on any catalog-fetch error, so this can never
  // wrongly send an unsupported provider a reasoning param).
  const reasoningRequested = 'reasoningEnabled' in resolved
    ? resolved.reasoningEnabled
    : await isGatewayModelReasoningCapable(modelId).catch(() => false);
  // FIX (2026-07-22): when neither byokModelId nor requestedModel was sent
  // by the client (the "Default model" / nothing explicitly picked case),
  // preSave above persisted requestedModel as null -- meaning a plain
  // page reload later would see byokModelId=null AND requestedModel=null
  // and misclassify this row as a legacy/eve-bucket chat (see
  // chat-interface.tsx's rowIsDirect), even though it was created and is
  // served entirely by this direct-chat route. Backfill the actually-
  // resolved model id into requestedModel once preSave's row exists, so
  // every row this route ever creates has a real requestedModel/
  // byokModelId and can never fall back into the (now fully retired) eve
  // path on a later load. Fire-and-forget, same posture as preSave.
  if (!byokModelId && !requestedModel) {
    void preSave.then(() =>
      prisma.eveChatSession
        .update({ where: { id: chatId, userId }, data: { requestedModel: modelId } })
        .catch(err => {
          console.error('[direct chat] default-model backfill failed', chatId, err);
          logError({ source: 'direct-chat-default-model-backfill', error: err, userId, chatId });
        }),
    );
  }


  const isThirdPartyResponsesRelay = 'isThirdPartyResponsesRelay' in resolved && resolved.isThirdPartyResponsesRelay;
  const isThirdPartyAnthropicRelay = 'isThirdPartyAnthropicRelay' in resolved && resolved.isThirdPartyAnthropicRelay;

  const messagesForModel = (isThirdPartyResponsesRelay || isThirdPartyAnthropicRelay) ? stripReasoningParts(uiMessages) : uiMessages;
  const converted = await convertToModelMessages(messagesForModel, { ignoreIncompleteToolCalls: true });
  const initialModelMessages = applyConversationCacheControl(converted);

  const disabledToolNames = Array.isArray(disabledTools) ? disabledTools.filter((t: unknown): t is string => typeof t === 'string') : [];

  const run = await withDeadline(
    start(runDirectChatTurnWorkflow, [{
      chatId,
      userId,
      turnUiMessages: uiMessages,
      initialModelMessages,
      disabledToolNames,
      byokModelId: byokModelId ?? null,
      requestedModel: byokModelId ? null : (requestedModel ?? null),
      reasoningRequested,
    }]),
    'workflow start()',
  );

  await prisma.eveChatSession.update({ where: { id: chatId, userId }, data: { cursor: { workflowRunId: run.runId } } }).catch(err => {
    console.error('[direct chat] failed to persist workflow run id', chatId, err);
    logError({ source: 'direct-chat-persist-run-id', error: err, userId, chatId });
  });

  return createUIMessageStreamResponse({
    stream: run.readable,
    headers: {
      'x-workflow-run-id': run.runId,
      'x-direct-chat-session-id': chatId,
      'x-direct-chat-provider': providerLabel,
      'x-direct-chat-model': modelId,
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
