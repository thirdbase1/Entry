/**
 * Durable direct-chat turn, decomposed into "legs" so a turn can survive
 * Vercel's 300s-per-invocation ceiling regardless of how long the overall
 * conversation runs (2026-08-07 migration off the old Redis turn-lock +
 * heartbeat + manual resumable-stream mirror in lib/direct-chat/turn-lock.ts
 * and timing.ts, both now retired -- Workflow SDK's own durable streams and
 * WorkflowChatTransport supersede that entire mechanism natively: a
 * dropped/killed connection is a normal, handled reconnect now, not a
 * failure that needs a synthetic heartbeat to paper over).
 *
 * WHY "LEGS": the original single-request implementation let ONE
 * streamText() call run its own internal multi-step tool-calling loop for
 * up to stepCountIs(400) steps, all inside one continuous function
 * invocation -- fine on a persistent server, fatal on Vercel where that
 * whole invocation is hard-capped at 300s (confirmed against this
 * project's actual Vercel config: Hobby + Fluid Compute = 300s ceiling,
 * period, regardless of what `maxDuration` the route declares). A single
 * `'use step'` is ITSELF still just one such invocation -- wrapping the
 * whole 400-step loop in one step would not fix anything. So this splits
 * the turn into "legs": each leg is its own step, running the EXACT SAME
 * streamText() call (same prepareStep/onStepFinish/onError/repairToolCall/
 * stopWhen/tools/reasoning config as the single-request version, copied
 * verbatim -- none of that hardened, incident-driven logic changes) but
 * bounded by an internal ~4.5-minute AbortController. Most turns finish in
 * one leg, well under that bound. If a turn is still going when the bound
 * fires, this leg ends cleanly (not a hard kill -- the model/tool state is
 * captured and persisted same as a natural finish) and the outer workflow
 * function starts a fresh leg (a fresh invocation, fresh 300s budget)
 * continuing from the exact same accumulated message history. Repeat for
 * as many legs as the turn actually needs -- the workflow function itself
 * has no overall duration limit, only each individual leg does.
 *
 * Tool execution durability (bash, browser_use, etc. actually taking a
 * long time) is handled one level deeper, inside each tool's own
 * getSandboxForChat().run() -- see sandbox-workflow.ts's file comment.
 * This file is what makes the SURROUNDING model+tool-loop orchestration
 * durable; that file is what makes any ONE long tool call durable. Both
 * are needed for a genuinely unbounded-duration agent turn.
 *
 * execCtx/tools can't be constructed once and threaded through -- they're
 * built from live closures (a sandbox getter, session context) that can't
 * cross a workflow step boundary, so build-tool-context.ts's builder is
 * called fresh, from plain serializable inputs, at the start of every leg.
 */
import {
  streamText,
  stepCountIs,
  smoothStream,
  InvalidToolInputError,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import { getWritable } from 'workflow';
import { prisma } from '@entry/db';
import { logError } from '@entry/db/error-log';
import { captureIncrementalSnapshot, captureTurnVersion } from '@entry/db/chat-versioning';
import { recordUsageEvent } from '@entry/db/usage-metering';
import { resolveByokModel } from '@/lib/byok/resolve-model';
import { markProviderCooldown } from '@/lib/byok/provider-cooldown';
import { PERMANENT_SIGNAL_PATTERN } from '@/lib/byok/gateway-retry-fetch';
import { resolveGatewayModel } from '@/lib/direct-chat/resolve-gateway-model';
import { resolveModelIdForProvider } from '@entry/agent/lib/model-catalog';
import { fillEmptyAssistantReply, describeRefusal } from '@/lib/direct-chat/fill-empty-refusal';
import { describeApiCallError } from '@/lib/direct-chat/describe-api-error';
import { mergeAndPersistChatEvents } from '@/lib/direct-chat/persist-chat-events';
import { sanitizeDanglingToolCalls } from '@/lib/direct-chat/sanitize-messages';
import { applyToolCacheBreakpoint } from '@/lib/direct-chat/prompt-cache';
import { buildDirectChatToolContext } from '@/lib/direct-chat/build-tool-context';
import { WRITER_HEARTBEAT_MS, makeHeartbeatChunk } from '@/lib/direct-chat/timing';

const FLAKY_PROVIDERS_DROP_TOOLS_AFTER_STEP_1 = new Set(['Woino']);

// Comfortably under Vercel Hobby+Fluid's confirmed real 300s-per-invocation
// ceiling, leaving margin for the persistence/version-capture work that
// still has to happen (inside this same step) after the model stream ends,
// before this leg can return.
const MAX_LEG_DURATION_MS = 4.5 * 60 * 1000;
// Same generous ceiling as the original single-request stopWhen -- this is
// STILL the safety net for "a step-loop that legitimately cannot stop
// itself" (a relay lying about finishReason), just now scoped per leg
// rather than per turn. A turn that needs more than this across ONE leg's
// worth of internal steps just continues into another leg anyway.
const MAX_LEGS = 200;

/**
 * COOPERATIVE STOP CHECK (added 2026-08-08, "stop button doesn't work").
 * `route.ts`'s /stop endpoint calls the Workflow SDK's `Run.cancel()`,
 * which stops the orchestrator from scheduling any FUTURE leg -- but a
 * leg already mid-flight (streaming from the model, running a tool) has
 * no SDK-exposed signal telling it a cancellation was requested, so it
 * would otherwise run to its own natural end (up to MAX_LEG_DURATION_MS)
 * regardless. The stop endpoint also flips a plain `stopRequested` flag
 * into the chat row's existing `cursor` JSON column (no schema change
 * needed); this cheap read piggybacks on the SAME cadence as the
 * already-existing WRITER_HEARTBEAT_MS heartbeat check in the leg's
 * forwarding loop below, so a stop request is noticed within one
 * heartbeat interval (~5s worst case) instead of never.
 */
async function isStopRequested(chatId: string): Promise<boolean> {
  try {
    const row = await prisma.eveChatSession.findUnique({ where: { id: chatId }, select: { cursor: true } });
    const cursor = row?.cursor;
    return !!(cursor && typeof cursor === 'object' && (cursor as { stopRequested?: boolean }).stopRequested === true);
  } catch {
    // A transient DB hiccup checking the flag should never itself abort a
    // healthy turn -- treat "couldn't check" as "not stopped" and let the
    // next heartbeat tick retry.
    return false;
  }
}

export interface TurnWorkflowInput {
  chatId: string;
  userId: string;
  turnUiMessages: UIMessage[]; // the turn's starting UIMessage[] baseline -- constant across every leg
  initialModelMessages: ModelMessage[]; // converted once in the route handler before start()
  disabledToolNames: string[];
  byokModelId: string | null;
  requestedModel: string | null;
  reasoningRequested: boolean;
}

interface LegInput extends TurnWorkflowInput {
  legMessages: ModelMessage[];
  legNumber: number;
}

interface LegResult {
  updatedModelMessages: ModelMessage[];
  doneNaturally: boolean;
}

async function runChatTurnLegStep(input: LegInput): Promise<LegResult> {
  'use step';
  // Called fresh inside the step, not threaded in as a workflow-level
  // argument (2026-08-07, cross-checked against workflow-sdk.dev/docs/
  // foundations/streaming's "Streams Cannot Be Used Directly in Workflow
  // Context" + its own canonical good-example: getWritable() with no
  // namespace always resolves to the SAME run-scoped default writable
  // regardless of which step calls it or how many times, so there's
  // nothing to gain from obtaining it once in the workflow function and
  // passing the reference through -- and doing so risked sitting right
  // on the documented "don't touch streams in workflow context" line for
  // no benefit. Every leg gets the identical persistent stream this way.
  const writable = getWritable<UIMessageChunk>();
  const { chatId, userId, turnUiMessages: uiMessages, legMessages, legNumber, disabledToolNames, byokModelId, requestedModel, reasoningRequested } = input;

  // Re-resolve fresh every leg -- see this file's header comment. Cheap
  // (one DB read + decrypt for BYOK, none at all for Gateway) relative to
  // an actual model call, and mirrors the original route's own resolution
  // logic exactly (including the cooldown-fallback substitution), just
  // without the substitutionNotice/preSave plumbing, which stays in the
  // route handler (one-time, turn-start concerns, not per-leg).
  const resolved = byokModelId
    ? await resolveByokModel(byokModelId, userId)
    : requestedModel
      ? resolveGatewayModel(requestedModel)
      : resolveGatewayModel(await resolveModelIdForProvider('anthropic'));
  const isByokResolved = (r: typeof resolved): r is Awaited<ReturnType<typeof resolveByokModel>> => 'providerId' in r;
  const { model, providerLabel, modelId } = resolved;
  const isThirdPartyResponsesRelay = 'isThirdPartyResponsesRelay' in resolved && resolved.isThirdPartyResponsesRelay;
  const isThirdPartyAnthropicRelay = 'isThirdPartyAnthropicRelay' in resolved && resolved.isThirdPartyAnthropicRelay;

  // Created before the tool context so it can be forwarded into execCtx
  // (agent.ts's sub-agent delegation and any other abortSignal-aware
  // nested tool call needs it at construction time) as well as into
  // streamText's own `abortSignal` option below.
  const legAbortController = new AbortController();
  const legTimer = setTimeout(() => legAbortController.abort(), MAX_LEG_DURATION_MS);

  const { execCtx, activeTools, instructions, getSandboxPromise } = await buildDirectChatToolContext({
    chatId, userId, model, disabledToolNames, abortSignal: legAbortController.signal,
  });

  let lastFinishReason: string | undefined;
  let lastRawFinishReason: string | undefined;
  let stepCount = 0;

  let persistChain: Promise<unknown[]> = Promise.resolve(uiMessages as unknown[]);
  function persistIncremental(newMessages: unknown[]): void {
    persistChain = persistChain
      .then(baseline => mergeAndPersistChatEvents(chatId, userId, baseline, newMessages))
      .catch(err => {
        console.error('[direct chat] incremental leg save failed', chatId, err);
        logError({ source: 'direct-chat-incremental-save', error: err, userId, chatId });
        return newMessages;
      });
  }
  function persistFinal(newMessages: unknown[]): Promise<unknown[]> {
    persistChain = persistChain
      .then(baseline => mergeAndPersistChatEvents(chatId, userId, baseline, newMessages))
      .catch(err => {
        console.error('[direct chat] final leg save failed', chatId, err);
        logError({ source: 'direct-chat-final-save', error: err, userId, chatId });
        return newMessages;
      });
    return persistChain;
  }

  let resolveCriticalSave: () => void = () => {};
  const criticalSaveDone = new Promise<void>(resolve => {
    resolveCriticalSave = resolve;
  });
  const CRITICAL_SAVE_TIMEOUT_MS = 5_000;

  const requestStartedAt = Date.now();
  const substitutionNotice: string | null = null;

  const result = streamText({
    model,
    // LOWERED BACK DOWN (2026-07-29, real bug, owner report: "why does
    // it take long for ALL shared ai to respond"). This was raised to 5
    // on 2026-07-25 specifically because 429/quota bursts (e.g. Google's
    // shared free-tier bucket) had nowhere else to be retried fast --
    // gateway-retry-fetch.ts's own wrapper (used by every BYOK/shared
    // model, see build-model-client.ts) didn't handle 429 AT ALL back
    // then, so every single 429 fell through to exactly THIS outer
    // AI-SDK-level retry, which uses the SDK's hardcoded, non-configurable
    // exponential backoff -- 2s, 4s, 8s, 16s, 32s between attempts (see
    // @ai-sdk/provider-utils's retryWithExponentialBackoff defaults,
    // `initialDelayInMs: 2000, backoffFactor: 2`, not overridable via
    // streamText's own options) -- up to 62 real SECONDS of pure waiting
    // on one turn before even counting actual request latency. Shared
    // providers pool many users onto one upstream account, so they hit
    // momentary 429s far more than a private BYOK key ever would --
    // exactly why this was disproportionately a "shared AI is slow"
    // complaint specifically, not a general one.
    //
    // Now that gateway-retry-fetch.ts properly retries 429 itself (added
    // 2026-07-29, see that file's own comment) with its OWN much cheaper
    // ~200ms-based backoff and correct permanent-vs-transient
    // classification, this outer retry is really only a thin safety net
    // for genuine transport-level failures (a thrown network exception
    // before any HTTP response came back at all, which never even
    // reaches the inner wrapper's status-code logic) -- it no longer
    // needs to carry the FULL weight of absorbing every 429 burst itself,
    // so it's brought back down to a modest value instead of layering a
    // second, much slower retry system on top of a problem the inner
    // wrapper now already solves quickly.
    maxRetries: 2,
    // RESTORED (2026-08-05, live bug: reported duplicate/looping assistant
    // responses in production, traced back to this exact guard being
    // dropped in the 'keep long turns alive through disconnects' pass).
    // That change correctly removed the ARTIFICIAL wall-clock/step budget
    // that used to cut long turns short (SOFT_DEADLINE_MS, stepCountIs(400)
    // used as a generic ceiling) -- but stepCountIs(400) and the relay-lie
    // detector below aren't a UI/runtime budget, they're the only thing
    // stopping a step-loop that legitimately cannot stop itself. Without
    // this, a relay that lies about finishReason ('tool-calls' with zero
    // actual tool calls -- confirmed real behavior, see the guard's own
    // history below) makes the AI SDK feed it another step FOREVER, each
    // one persisted as its own assistant message -- which is exactly what
    // reads as "duplicating agent response" in the UI, and separately
    // explains reports of a needsConnect card never appearing: the turn
    // never reaches the real tool call that would have produced it because
    // it's stuck re-running the lying step instead. 400 is generous enough
    // to never bound a genuine long turn in practice; it only bounds the
    // pathological case this guard exists for.
    abortSignal: legAbortController.signal,
    stopWhen: [
      stepCountIs(400),
      ({ steps }) => {
        if (steps.length < 2) return false;
        const last = steps[steps.length - 1];
        const prev = steps[steps.length - 2];
        const noToolCalls = (s: { toolCalls?: unknown[] }) => !s.toolCalls || s.toolCalls.length === 0;
        const noText = (s: { text?: string }) => !s.text || s.text.trim().length === 0;
        return noToolCalls(last) && noToolCalls(prev) && noText(last) && noText(prev);
      },
    ],
    // FIXED (2026-07-19, confirmed live from production logs): a 'Free'
    // BYOK relay (model id "claude-fable-5") hung completely on a turn --
    // zero chunks, zero onStepFinish, nothing -- for the FULL 300s
    // maxDuration, at which point Vercel hard-kills the entire function
    // with an opaque "Vercel Runtime Timeout Error". That's a strictly
    // worse failure mode than a normal thrown error: the kill happens at
    // the platform level, so onError/onFinish never run, nothing gets
    // saved or reported, and the client is left hanging with no visible
    // feedback for 5 full minutes. The nested tool-impls
    // (code_artifact/python_coding/task_analysis, see
    // with-timeout-signal.ts) already learned this lesson for their OWN
    // internal model calls; this is the identical gap at the TOP level,
    // for the turn's actual model call itself. chunkMs is the AI SDK's
    // own built-in stall detector (see
    // node_modules/ai/src/util/set-abort-timeout.ts) -- aborts a step if
    // NO chunk (not even the first) arrives within the window, which
    // turns into a normal catchable error (onError fires, a clean message
    // reaches the client) instead of a bare platform kill.
    //
    // RAISED (2026-07-23, real user-reported bug: "agent stops mid work,
    // every time, under 100s" -- reproducing exactly this cutoff). The
    // 90_000/240_000 values above were calibrated ONLY for the old
    // Vercel-hosted version of this route, specifically to fail fast and
    // clean well BEFORE Vercel's hard 300s kill so onFinish/version-
    // capture/save still had time to run. This route moved to Render
    // 2026-07-22 (persistent server, confirmed no request-duration
    // ceiling at all -- Render's own docs: "100-minute HTTP request
    // timeout by default"), so that original constraint is gone, but this
    // stall guard was never widened to match -- it stayed the tightest
    // limit in the whole system BY FAR, well under even the old 300s
    // figure it was designed to stay under. Any BYOK model/relay with
    // slower-than-90s first-token latency (large context, a heavily
    // reasoning-heavy model genuinely still "thinking" with no streamed
    // token yet, a loaded free/proxy relay queueing the request) got
    // silently killed here every single time, indistinguishable to the
    // user from "the model just stopped" -- because from the outside a
    // clean caught-and-reported abort and a real hang look identical:
    // the assistant's turn just ends. Widened to give real slow-starting
    // models genuine room to actually produce their first token, while
    // still eventually catching a truly dead connection well within
    // SOFT_DEADLINE_MS's 55-minute budget above (so onFinish/version-
    // capture/save still always gets to run afterward either way).
    // Deliberately scoped to "no data at all for 4 minutes", not a cap on
    // total step duration -- a model that's genuinely still producing
    // output stays completely unaffected no matter how long that takes;
    // only a truly dead connection gets cut.
    //
    // FIXED (2026-07-25, real user-reported bug: Claude Opus 5 BYOK turns
    // -- genuinely working, real tool calls, real progress -- reliably
    // cut off right around the ~10-minute mark, every long turn, no
    // exceptions). Root cause traced into node_modules/ai/src/generate-
    // text/stream-text.ts directly: unlike chunkTimeoutId (reset on EVERY
    // semantic chunk via resetChunkTimeout()), stepTimeoutId is armed
    // ONCE at the top of streamStep() and is NEVER reset for the rest of
    // that step -- so `stepMs` is actually a hard absolute ceiling on one
    // full step's total duration, not a "no progress" detector the way
    // the comment above (and this value's own prior history) assumed.
    // 600_000 (10 min) was carried over from when this was genuinely just
    // meant as "secondary safety net, comfortably under the old, much
    // shorter SOFT_DEADLINE_MS" -- but a single step from a heavy-
    // reasoning BYOK model (large context reprocessing + adaptive/
    // extended thinking + a long generated response) routinely NEEDS more
    // than 10 minutes, and was getting killed mid-work every time despite
    // streaming real chunks the whole way. Raised to 1_800_000 (30 min,
    // still well under SOFT_DEADLINE_MS's 55-minute budget with real
    // margin left for onFinish/version-capture/save) -- chunkMs above is
    // the thing that actually catches a truly dead connection; stepMs
    // only needs to catch the pathological "trickles forever, never
    // finishes" case, which 30 minutes still does just fine.
    // Disable AI SDK wall-clock/stall aborts; recovery is handled by the
    // persisted turn stream and DB snapshots, not by killing a live model.
    // NOTE: this AI SDK version's TimeoutConfiguration type is
    // `number | { totalMs?, stepMs?, ... }` -- it has no `false` variant
    // (that was a type error, never actually valid here). `undefined` is
    // the SDK's real "no timeout configured" value (see
    // getTotalTimeoutMs's own doc comment in node_modules/ai), so this
    // achieves the exact same intended effect this line always meant.
    timeout: undefined,
    // See modelMessages' own comment above for why this (persona prompt +
    // optional compaction summary) moved here instead of being spliced
    // into `messages` as fake `role: 'system'` entries -- this is the
    // SDK's actual supported slot for a system prompt that also needs a
    // providerOptions/cache_control attachment.
    instructions: await instructions,
    messages: legMessages,
    // No client-side reasoning-effort control anymore (2026-07-15,
    // explicit removal request) -- every model just runs at its own
    // provider default reasoning behavior. `'provider-default'` is always
    // a safe no-op to pass regardless of whether the resolved model
    // actually supports extended reasoning at all (confirmed in this same
    // file's earlier investigation), so no per-model capability check is
    // needed here anymore either.
    reasoning: reasoningRequested ? 'low' : 'provider-default',
    // BROAD-COMPATIBILITY REASONING PASSTHROUGH (2026-07-25, real ask:
    // "make the reasoning enable buttons work 100%") -- see
    // direct-chat-core.ts's identical 2026-07-25 comment (this route's
    // sibling implementation for the other channel) for the full
    // writeup. Short version: the portable `reasoning:` option above is
    // correctly translated for a REAL Anthropic/Google/OpenAI-Responses
    // connection, but most BYOK connections here are arbitrary third-
    // party OpenAI-compatible relays, and @ai-sdk/openai-compatible only
    // ever sends the OpenAI convention (`reasoning_effort`) for those --
    // not every relay's underlying model keys off that. Its own
    // confirmed source-level passthrough (getArgs() spreads any extra
    // key under providerOptions[providerOptionsName], which is exactly
    // this connection's own provider.label, straight into the raw
    // request body) lets this also send `enable_thinking` (Qwen-style)
    // and `thinking: { type: "enabled" }` (Anthropic-shaped-but-served-
    // over-openai-compatible-style) at the same time -- unrecognized
    // extra fields are harmless no-ops for relays that don't use them.
    ...(reasoningRequested && byokModelId
      ? { providerOptions: { [providerLabel]: { enable_thinking: true, thinking: { type: 'enabled' } } } }
      : {}),
    // FIXED (2026-07-16, confirmed live from production error logs): the
    // "Woino" relay (api.woino.app, a known-flaky third-party proxy --
    // already flagged once before as unreliable) 400s on the step-2+
    // request of every single agentic turn -- specifically the request
    // that carries a completed tool call + its result back for the model
    // to continue. Step 1 (the request that produces the tool call in the
    // first place) always succeeds; it's only the follow-up that their
    // relay can't handle, 100% reproducible across 6/6 recent turns in
    // prod logs. The user explicitly does not want this provider removed
    // or disabled, so instead of a hard crash on every tool-using turn:
    // drop tool availability from step 2 onward for this specific
    // known-flaky provider. This trades "no more tool calls after the
    // first one" for "the turn actually finishes instead of dying" --
    // by far the better trade for an unreliable relay we don't control.
    // Keyed off providerLabel (exact match) rather than baseUrl since
    // that's what's already resolved and logged for every turn.
    prepareStep({ stepNumber, messages }) {
      // REASONING-STRIP-ACROSS-STEPS (2026-07-25, confirmed live: real
      // production log, Claude Opus 5 via freemodel.dev -- a known
      // third-party Anthropic relay, not real api.anthropic.com --
      // showed a GROWING count of "unsupported reasoning metadata"
      // warnings step over step (2 at step 4, 3 at step 5) once thinking
      // was enabled for this model). Root cause: stripReasoningParts
      // (see that file's own comment) only ever cleaned the PRE-LOADED
      // chat history before a turn starts -- it has no way to touch
      // reasoning parts the model itself produces DURING this same turn's
      // earlier steps, which the AI SDK automatically resends on every
      // later step of the same multi-step tool-calling loop. A relay that
      // can't issue a genuine Anthropic `signature`/`redactedData` on its
      // thinking blocks (every third-party relay, by definition) has that
      // resent reasoning silently dropped with a warning EACH time,
      // forever, for the rest of the turn -- same underlying problem as
      // strip-reasoning-parts.ts, just occurring one level lower (within
      // a single turn's own step loop instead of across turns). Fixed the
      // same way: for exactly this relay class, strip any `reasoning`
      // content part out of `messages` before every step past the first
      // -- `messages` overrides here carry forward to all later steps
      // (the AI SDK's own documented behavior), so this needs to run once
      // per step, not just once per turn. Never affects real Anthropic/
      // OpenAI connections or Gateway models -- gated on the exact same
      // isThirdPartyAnthropicRelay/isThirdPartyResponsesRelay flags
      // resolve-model.ts already computes.
      const needsReasoningStrip =
        (isThirdPartyAnthropicRelay || isThirdPartyResponsesRelay) &&
        messages.some(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(p => p.type === 'reasoning'));
      const reasoningStripOverride = needsReasoningStrip
        ? {
            messages: messages.map(m =>
              m.role === 'assistant' && Array.isArray(m.content)
                ? { ...m, content: m.content.filter(p => p.type !== 'reasoning') }
                : m,
            ),
          }
        : {};

      if ((stepNumber > 0 || legNumber > 1) && FLAKY_PROVIDERS_DROP_TOOLS_AFTER_STEP_1.has(providerLabel)) {
        return { activeTools: [], ...reasoningStripOverride };
      }
      return { ...reasoningStripOverride };
    },
    // ADDED (2026-07-19, real bug: AI_NoSuchToolError: Model tried to call
    // unavailable tool 'Agent'/'Read' -- the model emitted a hallucinated
    // case variant (`Agent` instead of the registered `agent`) or a tool
    // that plain does not exist here at all (`Read` -- see read_file.ts's
    // header for that half of the fix). This is the AI SDK's own documented
    // recovery hook (parse-tool-call.ts: on NoSuchToolError/
    // InvalidToolInputError it calls `repairToolCall` with {toolCall,
    // tools}, and a non-null return gets re-parsed instead of failing the
    // whole turn) -- exactly the mechanism this class of bug calls for,
    // not another prompt-only patch (the 2026-07-19 availableTools
    // grounding block already tried that and the model still hallucinated
    // past it). Case-insensitive match ONLY: never invents a mapping to a
    // genuinely different tool (e.g. does not try to guess `Read` means
    // `bash` or `list_files`) -- returns null (no repair, original error
    // surfaces normally) whenever there's no case-insensitive match.
    repairToolCall: async ({ toolCall, tools, error }) => {
      const realName = Object.keys(tools).find(name => name.toLowerCase() === toolCall.toolName.toLowerCase());
      if (realName !== undefined && realName !== toolCall.toolName) {
        return { ...toolCall, toolName: realName };
      }
      // ADDED (2026-07-20, real bug reported live: write_file threw a raw
      // Zod "expected: string, received undefined, path: ['path']" straight
      // to the user). Root cause: models -- including this one, apparently
      // cross-contaminated by the very common `file_path` tool-arg
      // convention used elsewhere (this exact repo's OWN sandbox exposes a
      // DIFFERENT platform's tool as `file_path`, and plenty of training
      // data does too) -- sometimes call write_file/read_file/append_file/
      // edit_file with `file_path`/`filePath`/`filename`/`fileName` instead
      // of the real, required `path` key. That's an InvalidToolInputError
      // (schema validation failure on otherwise well-formed JSON), not a
      // NoSuchToolError, so it needs its own repair branch: parse the raw
      // input, and if `path` is missing but exactly one known alias is
      // present, rename it and let the SDK re-validate. Never invents a
      // value that wasn't in the original call -- returns null (original
      // error surfaces normally) whenever there's no such alias to rescue.
      const PATH_ALIASING_TOOLS = new Set(['write_file', 'read_file', 'append_file', 'edit_file']);
      const PATH_ALIASES = ['file_path', 'filePath', 'filename', 'fileName', 'file'];
      if (InvalidToolInputError.isInstance(error) && PATH_ALIASING_TOOLS.has(toolCall.toolName)) {
        try {
          const parsed = JSON.parse(error.toolInput) as Record<string, unknown>;
          if (typeof parsed.path !== 'string') {
            const aliasKey = PATH_ALIASES.find(key => typeof parsed[key] === 'string');
            if (aliasKey !== undefined) {
              const { [aliasKey]: aliasValue, ...rest } = parsed;
              const repaired = { ...rest, path: aliasValue };
              return { ...toolCall, input: JSON.stringify(repaired) };
            }
          }
        } catch {
          // Not parseable JSON -- fall through to no-repair below.
        }
      }
      return null;
    },
    onError({ error }) {
      console.error('[direct chat] streamText error', chatId, providerLabel, modelId, error);
      logError({ source: 'direct-chat-streamtext', error, userId, chatId, context: { providerLabel, modelId } });
      // See provider-cooldown.ts + the fallback-substitution block above --
      // only a genuinely PERMANENT account-level signal (insufficient
      // balance/quota, real auth failure, etc) should take this provider
      // out of rotation; a transient blip has no business benching a
      // provider that's actually fine.
      if (isByokResolved(resolved)) {
        const message = error instanceof Error ? error.message : String(error);
        if (PERMANENT_SIGNAL_PATTERN.test(message)) {
          markProviderCooldown(resolved.providerId, message);
        }
      }
    },
    // Added 2026-07-15 (explicit user report: "after one tool call model
    // still failed so log everything") — onError/turn-error above only
    // ever fire for a hard thrown error, which told us NOTHING about the
    // much more common silent case: the model completes a tool call step
    // cleanly (no error at all) and then either stops on its own
    // (finishReason 'stop'/'length'/'content-filter' when the user
    // expected it to keep going) or the NEXT step's provider call fails
    // in a way that got swallowed somewhere upstream of onError. Every
    // single step of every turn now logs its index, finish reason, which
    // tool(s) were called, whether each tool call actually produced a
    // result vs errored, and token usage -- so a "stopped after one tool
    // call" report is a five-second log lookup instead of a guess.
    async onStepFinish(step) {
      stepCount += 1;
      const { stepNumber, finishReason, rawFinishReason, toolCalls, toolResults, usage, text, warnings, content } = step;
      lastFinishReason = finishReason;
      lastRawFinishReason = rawFinishReason;
      const toolErrors = content
        .filter((part): part is Extract<typeof part, { type: 'tool-error' }> => part.type === 'tool-error')
        .map(part => ({ tool: part.toolName, error: part.error instanceof Error ? part.error.message : String(part.error) }));
      console.log('[direct chat] step finished', {
        chatId,
        providerLabel,
        modelId,
        stepNumber,
        finishReason,
        rawFinishReason,
        toolCallCount: toolCalls.length,
        toolNames: toolCalls.map(c => c.toolName),
        toolResultCount: toolResults.length,
        toolErrors,
        textLength: text.length,
        usage,
        warnings,
      });

      // USAGE METERING (Phase 1 of admin.md §2, 2026-07-19): one
      // UsageEvent row per completed step, captured verbatim from the
      // provider's own usage object -- never estimated. Metered per-STEP
      // (not once in onFinish) deliberately: a turn that ends early for
      // any reason never reaches onFinish, but its already-completed
      // steps DID consume tokens -- admin.md flags exactly this as "the
      // most common way a metering system quietly under-bills".
      // NO waitUntil() NEEDED HERE (superseding the 2026-07-23 note that
      // used to be here, which reasoned about a now-irrelevant platform).
      // This whole function body runs INSIDE a durable workflow step (see
      // this file's header) -- the workflow runtime itself is what keeps
      // this step's execution alive until it settles, completely
      // independent of the HTTP request/response that originally
      // triggered the run. There is no "does the platform freeze this
      // process before a background promise finishes" question to answer
      // at all here anymore; that entire class of problem is what moving
      // to workflow steps was FOR. Plain fire-and-forget with its own
      // `.catch` is all that's needed. Usage shape verified against THIS
      // repo's installed ai package (LanguageModelUsage): cache
      // reads/writes live in usage.inputTokenDetails, not in
      // providerMetadata.
      if (usage && (usage.inputTokens != null || usage.outputTokens != null)) {
        void recordUsageEvent({
          userId,
          chatId,
          source: 'direct-chat',
          model: modelId,
          provider: isByokResolved(resolved) && resolved.isShared
            ? `shared:${resolved.providerId}`
            : byokModelId
              ? `byok:${providerLabel}`
              : 'gateway',
          usage: {
            // inputTokens on LanguageModelUsage is the TOTAL (cached
            // included) -- price only the non-cached portion at the
            // input rate, or cache reads double-bill at full price.
            inputTokens: usage.inputTokenDetails?.noCacheTokens ?? usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            cacheCreationTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
            cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
          },
          finishReason,
          success: toolErrors.length === 0,
        }).catch((err: unknown) => {
          console.error('[direct chat] recordUsageEvent failed', chatId, err);
        });
      }
      // A step that finished for any reason OTHER than actually making
      // more tool calls or a normal stop, OR a tool call that came back
      // as an actual error, is exactly the "stopped after one tool call"
      // case the user is describing -- flag it loudly instead of letting
      // it blend into the normal per-step noise.
      if ((finishReason && finishReason !== 'tool-calls' && finishReason !== 'stop') || toolErrors.length > 0) {
        console.warn('[direct chat] step finished with unusual reason or tool error', {
          chatId,
          providerLabel,
          modelId,
          stepNumber,
          finishReason,
          rawFinishReason,
          toolCallCount: toolCalls.length,
          toolErrors,
        });
      }

      // INCREMENTAL VERSION CAPTURE (2026-07-18, user-reported: "sandbox
      // kept cleaning up file, it's not persistent"). This used to only
      // run once, at the very end of the whole turn, in `onFinish` below.
      // Real bug: a hard-killed turn (a long tool call pushing the whole
      // request past the outer 300s maxDuration, a crash, a dropped
      // connection) never reaches `onFinish` at all, so the git baseline
      // `restoreLatestFilesToSandbox` restores from after an eviction
      // stayed stuck wherever the LAST clean turn left it -- silently
      // losing every file change made during the one that got cut off.
      // Capturing after every step (tool call included), not just once
      // at the very end, means a mid-turn hard-kill now only ever loses
      // whatever happened after the last completed step, not the whole
      // turn. Skipped for steps with no tool calls (pure text) --
      // nothing on disk could have changed. captureVersionFromSandboxDiff
      // is already a cheap, safe no-op with no real diff, so this adds
      // no real cost beyond that.
      if (getSandboxPromise() && toolCalls.length > 0) {
        // FIXED (2026-07-23, real bug -- "slow after every tool call"
        // confirmed live): this used to be `await`ed right here, meaning
        // streamText would not even request the model's NEXT step until
        // a full git round-trip against the sandbox finished: an
        // is-inside-work-tree check, rewriting .gitignore, an
        // untrack pass over 15+ ignored dirs, then `git add -A`/diff/
        // commit across the ENTIRE sandbox working tree (this repo alone
        // is 130k+ files) -- all real network round-trips to a remote
        // sandbox, not local/free. That's dead, fully serial time added
        // after EVERY tool call, on EVERY turn, before the model could
        // even start thinking about its next step -- easily the single
        // biggest contributor to "slow after a tool call" reports.
        // Fire-and-forget instead: `captureVersionFromSandboxDiff` is
        // already serialized per-chatId internally (`chainByChat` in
        // chat-versioning.ts), so NOT awaiting it here doesn't risk two
        // concurrent git operations racing each other -- each call still
        // strictly runs after the previous one for this same chat.
        // Correctness is preserved because onFinish below still AWAITS
        // its own final captureVersionFromSandboxDiff call, which -- by
        // virtue of that same per-chat queue -- can't run until every
        // incremental capture kicked off here has already settled. Net
        // effect: the model's next step starts immediately after a tool
        // call instead of waiting on a git round-trip, and the turn's
        // hard-kill durability guarantee (the whole reason this runs
        // per-step, not just once at the end) is unchanged.
        void getSandboxPromise()?.then(sandbox =>
          // skipCard=true: the card must only be appended AFTER onFinish
          // persists the final sanitized messages -- appending it here races
          // with that write and causes the card to be overwritten (the card
          // lands in events, then onFinish overwrites events with
          // sanitizedFinalMessages which has no card). The version rows
          // (ChatVersion/ChatVersionFile) are still written here for
          // incremental durability; only the UI card is deferred.
          captureIncrementalSnapshot(chatId, sandbox)
        ).catch(err => {
          console.error('[direct chat] incremental step version capture failed', chatId, err);
        });
      }
    },
    tools: applyToolCacheBreakpoint(activeTools),
    // Fixed (2026-07-11, explicit user report: "streaming is not smooth at
    // all, looks like it's not streaming"): streamText had zero output
    // transform, so the UI's update cadence was entirely at the mercy of
    // however the upstream provider happened to chunk its own SSE bytes --
    // some OpenAI-compatible endpoints/proxies buffer several sentences (or
    // even the whole response) into one chunk, which renders as a single
    // big jump instead of a visible stream regardless of how correct the
    // client-side rendering is. `smoothStream` re-buffers the real
    // provider stream and re-emits it word-by-word
    // (AI SDK's own documented fix for exactly this complaint, see
    // ai-sdk.dev/docs/ai-sdk-core/streaming-text-generation#smoothing-the-stream)
    // -- decouples the visual cadence from the provider's actual chunk
    // boundaries so it always looks like a real, even stream no matter how
    // the upstream API batches it.
    //
    // CHANGED 2026-07-15, confirmed real cause of "streaming feels slow":
    // the SDK's own default here is `delayInMs: 10` -- a genuine, real
    // 10ms of ARTIFICIAL delay inserted between every single word purely
    // for visual smoothing, stacking linearly with response length (a
    // ~500-word reply loses a full 5 real seconds to this alone, on top
    // of actual generation time). Explicit `delayInMs: 0` keeps the
    // re-chunking behavior (still decouples from upstream's raw byte
    // boundaries, still renders word-by-word) while removing the
    // synthetic per-word wait entirely -- pure time-to-completion win,
    // no downside for a chat UI that's already rendering tokens as they
    // arrive.
    //
    // REVERTED PARTIALLY 2026-07-25 (explicit user report on THIS route:
    // "some model are damn faster so it lags"; matches the exact bug
    // already diagnosed and fixed on the sibling channel-chat path --
    // see apps/agent/agent/lib/direct-chat-core.ts's 2026-07-20 comment,
    // written for the same Pxxl port this route also now runs on but
    // never back-ported here): `delayInMs: 0` means smoothStream
    // re-chunks by word boundary but flushes every chunk with zero
    // pacing, so a fast provider/model that bursts several sentences
    // into one network chunk (common for OpenAI-compatible proxies/
    // relays) still renders as one big visual jump on this Pxxl
    // deployment, just chopped at word boundaries instead of mid-word --
    // the exact "fast but not smooth / laggy" symptom, and worse the
    // faster the model, since more real content piles up per burst.
    // `delayInMs: 6` is the same deliberate middle ground already proven
    // on the sibling path: real but small cost (a 500-word reply loses
    // 3s vs the SDK default's 5s) against a genuine perceived-smoothness
    // win -- a steady word-by-word reveal reads as faster to a human
    // than the same total duration delivered in bursts.
    // CLIENT-SIDE SMOOTHING (2026-07-27, "no matter how fast or slow
    // the model is, streaming is always smooth"): the server no longer
    // adds artificial per-word delay — `delayInMs: 0` means words are
    // re-chunked (still decouples from the provider's raw byte
    // boundaries) but flushed immediately. The CLIENT now handles
    // smoothness via `SmoothStreamingText` (requestAnimationFrame-based
    // text reveal at 60fps), which adapts to both fast and slow models
    // and both good and bad internet — see smooth-streaming-text.tsx.
    // Removing the server delay also eliminates the 3-5 seconds of
    // artificial latency that `delayInMs: 3-10` added to every reply.
    experimental_transform: smoothStream({ chunking: 'word', delayInMs: 0 }),
  });

  const innerUiStream = result.toUIMessageStream({
    originalMessages: uiMessages,
    generateMessageId: () => crypto.randomUUID(),
    sendReasoning: true,

    // TURN TIMER (2026-07-23, explicit user request: "show time each AI
    // response turn took when it stop"). Deliberately computed HERE --
    // server-side, from `requestStartedAt` captured before streamText was
    // even called -- rather than the client timing its own fetch: a
    // client-side timer would be wrong (or stuck) on a background-tab
    // throttle, a mid-turn reconnect (direct-chat-interface.tsx's own
    // online/visibilitychange recovery fetch, see its file comment),
    // or any hiccup between "user hit send" and "browser actually saw the
    // first byte" -- none of which are part of the model's real think+
    // generate time. `part.type === 'finish'` (not 'finish-step') is the
    // ONE part that fires exactly once, when the WHOLE turn (every step,
    // every tool call) is truly done -- see toUIMessageChunk's handling a
    // few hundred lines into node_modules/ai/dist/index.js, confirmed
    // this is the single point where `messageMetadata`'s return value
    // gets embedded directly on the same 'finish' stream chunk the client
    // already listens for. AI SDK's own updateMessageMetadata does a
    // shallow merge (mergeObjects) into message.metadata, so this can
    // never collide with or overwrite any other metadata key -- and
    // because it rides the SAME reconstruction path onFinish below
    // already uses for `finalMessages`, the exact figure shown live in
    // the UI the instant the turn finishes is IDENTICAL to what gets
    // durably persisted to `sanitizedFinalMessages` and survives a full
    // page reload -- no separate/duplicate timing logic to drift out of
    // sync, nothing to get stuck at a stale value since it's set exactly
    // once, atomically, at the one guaranteed-to-fire completion point.
    // WIDENED (2026-07-23, real user-reported bug: "timer never shows on
    // a turn that doesn't complete, and sometimes it's wrong"). This used
    // to only fire on `part.type === 'finish'` -- but 'finish' is the ONE
    // part that does NOT fire when a turn ends via a genuine error (a
    // dead BYOK relay, a provider-side abort, a thrown tool error that
    // propagates up): that path emits a 'error' part instead, and
    // `onFinish` below is *also* skipped for the exact same reason (see
    // its own comment thread above, "a turn that ends early for any
    // reason never reaches onFinish"). Net effect: an errored turn's
    // message.metadata.durationMs was never set at all, so the client had
    // nothing final to show once its own live ticking clock stopped
    // (that clock is gated on `chat.status === 'streaming' | 'submitted'`,
    // which flips away the instant the error lands) -- a permanent blank
    // gap between "still ticking" and "shows the final number", for every
    // single non-clean turn ending. Also handling 'error' here uses the
    // exact same proven mechanism 'finish' already relies on (AI SDK's
    // own message-metadata chunk + shallow merge into message.metadata,
    // see this function's own comment above) -- not a second, separate
    // timing path that could drift out of sync, just the same one firing
    // on one more terminal part type. Deliberately still NOT firing on
    // every part (e.g. every text-delta/tool chunk): doing that would
    // make the displayed number freeze between chunks during a long
    // silent tool call instead of ticking smoothly, which is exactly the
    // "glitchy" symptom the live client clock (turn-timer.tsx) was built
    // to avoid in the first place -- 'finish' and 'error' are the only
    // two terminal, guaranteed-at-most-once-per-turn part types, so this
    // stays a clean, atomic, single write on whichever one actually ends
    // the turn.
    messageMetadata({ part }) {
      if (part.type === 'finish' || part.type === 'error') {
        return {
          durationMs: Date.now() - requestStartedAt,
          ...(substitutionNotice ? { substitutionNotice } : {}),
        };
      }
    },
    onError(error) {
      // Default behavior swallows the real error into a generic "An error
      // occurred." with nothing else — confirmed cause of "tool calls fail
      // and the AI doesn't respond, no error even shown". Log the full
      // error server-side (console for a live tail + a durable DB row so
      // it's still findable after the fact, see logError's file comment)
      // and surface a real, readable message to the client instead.
      console.error('[direct chat] turn error', chatId, providerLabel, modelId, error);
      logError({ source: 'direct-chat-turn', error, userId, chatId, context: { providerLabel, modelId } });
      // Extracts the real reason even when error.message comes back empty
      // (confirmed live cause: freemodel.dev's 402 "Usage limit reached"
      // -- see describe-api-error.ts's file comment for the full story).
      return describeApiCallError(error);
    },
    async onFinish({ messages: finalMessages }) {
      // Same repair as above, applied to what THIS turn is about to
      // persist — a stream cut off mid-tool-call (disconnect, crash, an
      // execute() that never resolves) would otherwise save a dangling
      // call right now and brick every future turn on this chat, exactly
      // the failure this whole file's sanitizer exists to prevent.
      const sanitizedFinalMessages = fillEmptyAssistantReply(
        sanitizeDanglingToolCalls(finalMessages as UIMessage[]),
        lastFinishReason,
        lastRawFinishReason
      );
      // RACE-SAFE (2026-07-23, see persist-chat-events.ts's file comment):
      // used to be a blind `update({ data: { events: sanitizedFinalMessages } })`
      // built from THIS request's own request-start `uiMessages` snapshot --
      // clobbered anything a concurrent turn on the same chatId had
      // already committed since then. `uiMessages` (this turn's own
      // baseline) vs `sanitizedFinalMessages` (baseline + this turn's own
      // new reply) gives mergeAndPersistChatEvents an exact delta to
      // append onto the row's actual current state instead of overwriting it.
      await persistFinal(sanitizedFinalMessages).finally(() => {
        // See CRITICAL-SAVE GATE comment above -- releases the relay
        // loop's held `finish` chunk the instant this write settles,
        // whether it succeeded or failed.
        resolveCriticalSave();
      });

      // Universal, tool-agnostic version capture (2026-07-16, real bug:
      // "no matter the tool it use to change something in file... the
      // card should show instantly") -- diffs the sandbox's real
      // filesystem against its git baseline from the end of the
      // previous turn, so this sees every change regardless of which
      // tool made it (write_file/edit_file/append_file, or a raw bash
      // rm/mv/sed/redirect that none of those ever touch). Only runs if
      // some tool actually created a sandbox this turn -- `sandboxPromise`
      // stays undefined otherwise, meaning nothing on disk could have
      // changed. Deliberately awaited here (not deferred to the
      // `consumeStream` after() below) so appendVersionCardMessage's
      // events-append -- and this same route's own final-save write
      // above -- can never race each other.
      if (getSandboxPromise()) {
        const sandbox = await getSandboxPromise()!;
        await captureTurnVersion(chatId, sandbox).catch(err => {
          console.error('[direct chat] version capture failed', chatId, err);
        });
      }

      // NOTE (2026-07-22, Render migration -- user explicitly wants Render-only,
      // no Trigger.dev): this app now runs on Render (a persistent server, not
      // Vercel serverless), so there's no hard 300s kill forcing a background
      // handoff anymore -- the turn just keeps running in this same process
      // until it genuinely finishes (see the model terminal callback above,
      // both raised generously now that there's no platform timeout to race).
      // `finishedNaturally` is kept only as an observability signal for the rare
      // case a turn still hits the step cap or gets cut mid-tool-call --
      // `sanitizedFinalMessages` is already durably persisted above either way,
      // so the user can just send another message ("continue") to pick up from
      // the real last checkpoint. No Trigger.dev dependency anywhere in this path.
      // Completion is determined by the model/SDK terminal callback only;
      // no local deadline or step budget is allowed to label a live turn as
      // incomplete or ask the user to continue manually.
      console.log('[direct chat] turn finished', { chatId, stepCount, lastFinishReason });
    },
  });

  clearTimeout(legTimer);

  const writer = writable.getWriter();
  let sawRealContent = false;
  let turnErrored = false;
  try {
    // HEARTBEAT DURING SILENT GAPS (reinstated 2026-08-07 -- this was
    // dropped when the old single-request writer loop (route.ts) got
    // replaced by this leg's plain `for await`, which is WRONG: workflow
    // durability answers "does the server keep working across a dropped
    // connection", a completely different question from "does an
    // intermediate proxy/carrier gateway kill an HTTP connection after N
    // seconds of raw byte silence" -- the exact, previously-incident-
    // confirmed failure mode (see timing.ts's file header: "agent stops
    // at 1 min but runs for 21 min"). A long silent tool call (e.g. an
    // E2B sandbox build step deep inside a tool's execute()) still
    // produces zero chunks from `innerUiStream` for its whole duration --
    // that silence is now on THIS leg's writable, same physical HTTP
    // connection concern as before, workflow or not. Fix: race each
    // `.next()` against WRITER_HEARTBEAT_MS and write a padded no-op
    // chunk on timeout, looping until the real next chunk actually
    // arrives -- functionally identical to the old writer's race, just
    // relocated to where the forwarding loop now lives. This is the ONLY
    // place this needs fixing: a reattaching client (WorkflowChatTransport
    // reconnect, or the [chatId]/stream GET route) reads from the SAME
    // underlying run stream this writes to, so it inherits these
    // heartbeats automatically -- no separate reader-side keepalive
    // needed, unlike the old two-sided Redis-mirror design.
    const iterator = innerUiStream[Symbol.asyncIterator]();
    while (true) {
      const HEARTBEAT = Symbol('heartbeat');
      const next = await Promise.race([
        iterator.next(),
        new Promise<typeof HEARTBEAT>(resolve => setTimeout(() => resolve(HEARTBEAT), WRITER_HEARTBEAT_MS)),
      ]);
      if (next === HEARTBEAT) {
        // STOP CHECK (2026-08-08): piggyback on this existing heartbeat
        // cadence to notice a user-requested stop -- see isStopRequested's
        // own comment. Aborting the leg's own controller here (not just
        // breaking this loop) is what actually cuts the in-flight
        // streamText call short instead of letting it keep consuming
        // tokens in the background after the user already asked to stop.
        if (!legAbortController.signal.aborted && (await isStopRequested(chatId))) {
          legAbortController.abort();
        }
        await writer.write(makeHeartbeatChunk());
        continue;
      }
      const { value: chunk, done } = next as IteratorResult<UIMessageChunk>;
      if (done) break;
      if (chunk.type === 'text-delta' && chunk.delta.trim().length > 0) {
        sawRealContent = true;
      } else if (chunk.type.startsWith('tool-')) {
        sawRealContent = true;
      }
      if (chunk.type === 'error') {
        turnErrored = true;
      }
      if (chunk.type === 'finish') {
        // CRITICAL-SAVE GATE (carried over verbatim in spirit from the
        // single-request version) -- the 'finish' chunk is what tells the
        // client's useChat the turn is over; it must never arrive before
        // onFinish's own persistFinal write above has actually landed, or
        // a client that immediately navigates/refetches on seeing 'finish'
        // can land on a stale DB row (see this file's persistFinal call
        // above, and the original route's now-retired identical gate).
        await Promise.race([criticalSaveDone, new Promise<void>(resolve => setTimeout(resolve, CRITICAL_SAVE_TIMEOUT_MS))]);
      }
      await writer.write(chunk);
    }
  } catch (err) {
    console.error('[direct chat] leg stream consumption failed', chatId, legNumber, err);
    logError({ source: 'direct-chat-leg-consume', error: err, userId, chatId });
    turnErrored = true;
  }

  if (!sawRealContent && !turnErrored) {
    const id = crypto.randomUUID();
    const fallbackText = describeRefusal(lastFinishReason, lastRawFinishReason);
    await writer.write({ type: 'text-start', id });
    await writer.write({ type: 'text-delta', id, delta: fallbackText });
    await writer.write({ type: 'text-end', id });
  }
  writer.releaseLock();

  // A leg that was cut short by OUR OWN abort (not a genuine model/SDK
  // terminal state) is not "done" -- the workflow loop below starts
  // another leg, continuing from this leg's own accumulated messages.
  const doneNaturally = !legAbortController.signal.aborted;
  // `result.responseMessages` is the SDK's own accumulated assistant/tool
  // ModelMessage[] generated across every internal step of THIS leg's
  // streamText call -- appended onto legMessages (this leg's starting
  // history) gives the correct full history to feed the NEXT leg, exactly
  // matching what the single-request version fed back into its own
  // internal loop step-over-step, just now crossing a leg boundary instead.
  const generatedThisLeg = await result.responseMessages;
  return { updatedModelMessages: [...legMessages, ...generatedThisLeg] as ModelMessage[], doneNaturally };
}

/**
 * Outer orchestrator -- suspends between legs at essentially zero cost
 * (Fluid Compute is enabled on this project, confirmed 2026-08-07), and
 * has no overall duration limit of its own. See this file's header
 * comment for the full "why legs" writeup.
 */
export async function runDirectChatTurnWorkflow(input: TurnWorkflowInput): Promise<{ legCount: number }> {
  'use workflow';
  // No getWritable() call here anymore -- see runChatTurnLegStep's own
  // comment. The workflow function's only job is orchestrating which
  // step runs next with which accumulated message history; it never
  // touches the stream itself.
  let legMessages = input.initialModelMessages;
  let legNumber = 0;
  let doneNaturally = false;
  while (!doneNaturally && legNumber < MAX_LEGS) {
    // STOP CHECK (2026-08-08): also gate the NEXT leg, not just the
    // in-flight one -- covers the case where a stop lands in the small
    // window right after one leg finishes naturally but before the next
    // one starts (e.g. a leg that just wrapped up a tool call and was
    // about to loop for another turn of the model).
    if (legNumber > 0 && (await isStopRequested(input.chatId))) break;
    legNumber += 1;
    const legResult = await runChatTurnLegStep({ ...input, legMessages, legNumber });
    legMessages = legResult.updatedModelMessages;
    doneNaturally = legResult.doneNaturally;
  }
  return { legCount: legNumber };
}
