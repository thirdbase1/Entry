/**
 * Direct-model chat turn — the ONLY path for a chat where the user
 * explicitly picked a model in the selector, whether one of their own
 * BYOK provider models (`byokModelId`) or a Vercel AI Gateway model
 * (`requestedModel`, e.g. "deepseek/deepseek-v4-pro"). Formerly two
 * separate concerns (this route absorbs what used to live at
 * /api/byok/chat, now generalized) — merged because they were always
 * the same problem: eve's root agent (agent.ts's fixed `model:`, always
 * Claude) used to be the mandatory first hop for EVERY turn, including
 * ones that only ever intended to delegate the whole turn to a different
 * model via the `run_model` tool. That indirection was the root cause of
 * three real, confirmed bugs (2026-07-10):
 *
 *   1. run_model used a single blocking generateText call, so a delegated
 *      model's answer never streamed — root just relayed the whole
 *      finished text at once, token-by-token typing effect faked or
 *      absent entirely depending on client rendering.
 *   2. No reasoning/thinking content was ever requested or forwarded
 *      through that relay — even models that produce it had it silently
 *      dropped before reaching the client.
 *   3. Root sometimes just answered identity questions ("what model are
 *      you") AS ITSELF instead of reliably delegating — a user who picked
 *      DeepSeek could be told "I'm Claude", because "always delegate" is
 *      an instruction a system prompt can request but never fully
 *      guarantee.
 *
 * Fix: any explicit model selection now routes here directly (see
 * chat-interface.tsx's isDirect branch) and IS the whole turn's model —
 * this route calls it with streamText itself, no relay, no possibility of
 * a different model answering on its behalf. eve's root agent
 * (model-catalog-resolved, still Claude by default) now only ever runs
 * when nothing was explicitly picked (the "Default" option).
 *
 * Standard AI SDK v5+ shape throughout (pairs with @ai-sdk/react's
 * useChat + DefaultChatTransport): client posts
 * `{ id, messages, byokModelId }` OR `{ id, messages, requestedModel }`
 * where `messages` is the full UIMessage[] history (DefaultChatTransport's
 * default request body); we convert to ModelMessage[] for the model call
 * and persist the full UIMessage[] (including tool + reasoning parts) via
 * toUIMessageStreamResponse's onFinish.
 *
 * Tool parity: full parity with eve's root agent's 10 tools, including
 * bash and browser_use (2026-07-11) — both need a real sandbox, which
 * used to only exist inside an authored eve runtime execution. Fixed by
 * lib/direct-chat/sandbox.ts, a standalone `@vercel/sandbox` wrapper
 * (same underlying SDK eve's own `vercel()` backend uses) keyed by
 * chatId instead of an eve session id — see that file's comment for why
 * this was a real, confirmed gap (BYOK/Gateway-direct users truthfully
 * being told "no live browser" for a feature the default chat path has
 * always had). Every tool execute is wrapped with safeExecute at the source
 * (lib/tool-impls/*.ts) so a thrown error (bad key, upstream outage, etc.)
 * always resolves to a normal `{ error }` tool result the model can see
 * and explain, instead of an uncaught rejection that can tear down the
 * whole in-flight stream — confirmed root cause of "tool calls make the
 * AI just stop" (PARALLEL_API_KEY was empty in production; fixed
 * separately, but the wrapper is what stops ANY tool's upstream failure
 * from doing the same thing again).
 */
import { NextRequest, after } from 'next/server';

// Long autonomous agentic turns (many chained tool calls) need real runway,
// not the Next.js/Vercel default 300s. 1800s is the current hard ceiling
// Vercel allows at all (Pro/Enterprise "extended max duration" beta) — a
// single HTTP function invocation cannot run longer than that on this
// platform today, full stop; genuinely unbounded (e.g. 50+ minute)
// autonomous runs need Vercel Workflows' pause/resume durable-execution
// model instead of a plain function, which is a real architecture change,
// not a config tweak (see chat about this if/when needed).
export const maxDuration = 1800;
import { streamText, tool, stepCountIs, convertToModelMessages, smoothStream, type UIMessage } from 'ai';
import { getUserSessionFromRequest } from '@entry/auth';
import { prisma } from '@entry/db';
import { logError } from '@entry/db/error-log';
import { withApiErrorHandling } from '@/lib/api-error';
import { resolveByokModel } from '@/lib/byok/resolve-model';
import { resolveGatewayModel } from '@/lib/direct-chat/resolve-gateway-model';
import { getSandboxForChat } from '@/lib/direct-chat/sandbox';
import { isGatewayModelReasoningCapable, isByokModelReasoningCapable } from '@/lib/direct-chat/reasoning-capability';
import { sanitizeDanglingToolCalls } from '@/lib/direct-chat/sanitize-messages';
import { compactMessagesIfNeeded } from '@/lib/direct-chat/compact-messages';
import { applyToolCacheBreakpoint, buildCachedSystemMessage, applyConversationCacheControl } from '@/lib/direct-chat/prompt-cache';
import { buildPersonaInstructions } from '@entry/agent/lib/persona';
import type { ToolExecCtx } from '@entry/agent/tool-impls/types';

import { choose } from '@entry/agent/tool-impls/choose';
import { webCrawl } from '@entry/agent/tool-impls/web_crawl';
import { webSearch } from '@entry/agent/tool-impls/web_search';
import { taskAnalysis } from '@entry/agent/tool-impls/task_analysis';
import { codeArtifact } from '@entry/agent/tool-impls/code_artifact';
import { makeItReal } from '@entry/agent/tool-impls/make_it_real';
import { docCompose } from '@entry/agent/tool-impls/doc_compose';
import { pythonCoding } from '@entry/agent/tool-impls/python_coding';
import { browserUse } from '@entry/agent/tool-impls/browser_use';
import { listFilesTool } from '@entry/agent/tool-impls/list_files';
import { bash } from '@entry/agent/tool-impls/bash';
import { saveCredentialTool } from '@entry/agent/tool-impls/save_credential';
import { listCredentialsTool } from '@entry/agent/tool-impls/list_credentials';
import { injectCredentialTool } from '@entry/agent/tool-impls/inject_credential';
import { createSkillTool } from '@entry/agent/tool-impls/create_skill';
import { listSkillsTool } from '@entry/agent/tool-impls/list_skills';
import { recallSkillTool } from '@entry/agent/tool-impls/recall_skill';
import { getPreviewUrlTool } from '@entry/agent/tool-impls/get_preview_url';
import { restartSandboxTool } from '@entry/agent/tool-impls/restart_sandbox';
import { z } from 'zod';

const SYSTEM_PROMPT = buildPersonaInstructions();

export const POST = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const body = await req.json().catch(() => ({}));
  const { id, messages, byokModelId, requestedModel, reasoningEffort, disabledTools } = body ?? {};
  if (!byokModelId && !requestedModel) {
    return Response.json({ error: 'byokModelId or requestedModel is required' }, { status: 400 });
  }
  // Portable AI SDK v7 top-level `reasoning` control (see
  // ai-sdk.dev/docs/ai-sdk-core/reasoning) — safe to pass for any model:
  // providers that don't support reasoning just ignore it with a warning.
  // Only ever trust one of the 5 known levels from the client; anything
  // else (missing, stale localStorage value, tampering) falls back to
  // 'provider-default' rather than erroring the whole turn.
  // Full portable set per ai-sdk.dev/docs/ai-sdk-core/reasoning (AI SDK 7):
  // 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'.
  // Previously only 4 of these 7 were recognized (missing 'minimal' and
  // 'xhigh'), silently downgrading either to 'provider-default'.
  const REASONING_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'provider-default']);
  const resolvedReasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'provider-default' = REASONING_LEVELS.has(
    reasoningEffort
  )
    ? reasoningEffort
    : 'provider-default';
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'messages is required' }, { status: 400 });
  }
  // Repair any dangling tool-call left over from an interrupted earlier
  // turn BEFORE it's used for anything below (both for convertToModelMessages
  // and for preSave's own persisted copy) — see sanitize-messages.ts's file
  // comment for the full story on why an unrepaired one throws instantly,
  // before the model is ever called, and bricks every future turn in this
  // same chat until repaired.
  const uiMessages = sanitizeDanglingToolCalls(messages as UIMessage[]);

  // Resolve BEFORE any streaming starts — a bad/missing key or unknown
  // model slug surfaces as a clean JSON error, not a broken half-open
  // stream.
  const resolved = byokModelId
    ? await resolveByokModel(byokModelId, userId)
    : resolveGatewayModel(requestedModel);
  const { model, providerLabel, modelId } = resolved;
  // Manual per-model override (2026-07-11) — only ever present on the BYOK
  // branch (resolveGatewayModel's return shape has no such field, Gateway
  // models are always heuristic-free via the real catalog tag instead).
  // See reasoning-capability.ts's file comment for why the BYOK heuristic
  // needs an escape hatch at all: it's a naming-pattern guess with real
  // false negatives, and this is the user explicitly telling us better.
  const manualReasoningOverride = byokModelId ? (resolved as { reasoningEnabled?: boolean }).reasoningEnabled === true : false;

  // Gate the reasoning param on whether this SPECIFIC resolved model
  // actually supports it — never trust the client alone here. Confirmed
  // real bug (2026-07-11): forwarding a `reasoning` value unconditionally
  // to every model, including plain non-reasoning ones, made turns fail
  // outright for some providers (OpenAI-compatible endpoints reject any
  // `reasoning_effort` at all on a non-reasoning model with a hard 400 —
  // see reasoning-capability.ts's file comment for the confirmed source).
  // 'provider-default' never needed gating (it was already a no-op), so
  // this only changes behavior for an explicit non-default pick against a
  // model that doesn't support it — from "the whole turn errors" to "runs
  // fine at the model's own default reasoning behavior".
  //
  // Confirmed real bug (2026-07-11, found investigating "tool calls are
  // slow"): this was a hard `await` sitting here, BEFORE preSave and
  // BEFORE streamText even started. Both branches ultimately call
  // getReasoningCapableGatewaySlugs(), which on any cache miss/expiry (its
  // TTL is 5 minutes) does a real external fetch to
  // ai-gateway.vercel.sh/v1/models/catalog — so roughly every 5 minutes,
  // literally every single turn (BYOK or Gateway, reasoning-capable model
  // or not) paid that entire external round trip serially in front of the
  // actual model call, on top of whatever the provider itself took. Same
  // shape of bug as the preSave fix below (a network call sitting in the
  // critical path that the model call never actually depended on) —
  // fixed the same way: kick it off now, only await the result at the
  // one place it's actually consumed (right before streamText).
  const reasoningCapablePromise = manualReasoningOverride
    ? Promise.resolve(true)
    : byokModelId
      ? isByokModelReasoningCapable(modelId)
      : isGatewayModelReasoningCapable(modelId);

  const chatId = typeof id === 'string' && id ? id : crypto.randomUUID();

  // Persist the user's turn to the row BEFORE the turn finishes, not only
  // in onFinish — so if the model call itself fails outright (network,
  // bad key, upstream outage) the user's own message is never silently
  // lost. onFinish below still overwrites `events` with the complete
  // exchange (including the assistant's reply) once the turn succeeds.
  //
  // This DB round-trip (1-2 Neon queries) used to run sequentially BEFORE
  // streamText() was even called, adding its full latency to time-to-
  // first-token on every single turn for no reason — the model call
  // doesn't depend on this write succeeding first, and the write doesn't
  // depend on the model call either. Kicking it off concurrently with
  // preparing the model call (below) removes it from the critical path:
  // it now overlaps with the provider's own connection setup instead of
  // stacking in front of it. Still fully awaited (see `await preSave`
  // right before the response is returned) so the durability guarantee
  // above is unchanged — only the ORDERING relative to streamText's own
  // network call changed, not whether either one is awaited.
  const preSave = (async () => {
    const existing = await prisma.eveChatSession.findFirst({ where: { id: chatId, userId } });
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
      await prisma.eveChatSession.update({ where: { id: chatId, userId }, data: { events: uiMessages as any } });
    }
  })().catch(err => {
    console.error('[direct chat] pre-stream save failed', chatId, err);
    logError({ source: 'direct-chat-presave', error: err, userId, chatId });
  });

  // Minimal structural ctx — enough for the 10 reused tool-impls. See
  // ToolExecCtx: only `session.id` / `session.auth.current.principalId`
  // are read by most tools here (make_it_real/doc_compose for saving
  // docs under the right user+chat; the sub-generation tools read
  // `byokModel` so THEY also honor the resolved model instead of quietly
  // falling back to Gateway). `getSandbox` now lazily creates/resumes a
  // real Vercel Sandbox keyed by chatId (see lib/direct-chat/sandbox.ts)
  // instead of throwing — bash and browser_use below both call it.
  let sandboxPromise: ReturnType<typeof getSandboxForChat> | undefined;
  const execCtx: ToolExecCtx = {
    session: { id: chatId, auth: { current: { principalId: userId } } },
    byokModel: model,
    async getSandbox() {
      if (!sandboxPromise) sandboxPromise = getSandboxForChat(chatId);
      return sandboxPromise;
    },
  };

  // Runs concurrently with `preSave` above (both kicked off, neither
  // awaited yet) rather than after it — see preSave's comment.
  //
  // Compaction (2026-07-14): only shortens what's sent to the model for
  // THIS call -- `uiMessages` itself (persisted + shown in the UI) is
  // never touched. See compact-messages.ts's file comment for the real
  // gap this closes (this path had zero context-window protection
  // before, unlike eve's root agent's built-in `compaction` config).
  const modelMessages = compactMessagesIfNeeded(uiMessages, model, modelId).then(async ({ messages, wasCompacted }) => {
    if (wasCompacted) {
      console.log('[direct chat] compacted history before model call', { chatId, modelId, originalCount: uiMessages.length, sentCount: messages.length });
    }
    // Cache breakpoints (2026-07-14): the system prompt gets its own
    // message here (a plain `system:` string param on streamText has no
    // providerOptions slot to attach cache_control to) plus a breakpoint
    // on the last user+assistant turn, so the growing conversation history
    // itself gets cached incrementally as the chat gets longer -- see
    // prompt-cache.ts's file comment for the full "why".
    const converted = await convertToModelMessages(messages);
    return applyConversationCacheControl([buildCachedSystemMessage(SYSTEM_PROMPT), ...converted]);
  });

  // Only `choose` and `web_crawl` are always-on (not user-toggleable in
  // the Tools menu — see chat-config.tsx's `configurableTools`); every
  // other entry here can be individually turned off. Building the full
  // set and then filtering (rather than a chain of `disabledSet.has(...)
  // ? undefined : tool(...)` conditionals scattered inline) keeps the
  // filter logic in one obvious place and the tool defs themselves
  // unchanged from before.
  const disabledToolSet = new Set(Array.isArray(disabledTools) ? disabledTools.filter((t: unknown): t is string => typeof t === 'string') : []);
  const allTools = {
    choose: tool({ description: choose.description, inputSchema: choose.inputSchema, execute: choose.execute }),
    web_crawl: tool({ description: webCrawl.description, inputSchema: webCrawl.inputSchema, execute: webCrawl.execute }),
    web_search: tool({ description: webSearch.description, inputSchema: webSearch.inputSchema, execute: webSearch.execute }),
    task_analysis: tool({
      description: taskAnalysis.description,
      inputSchema: taskAnalysis.inputSchema,
      execute: (input: { task: string; context?: string; availableTools?: string[] }) => taskAnalysis.execute(input, execCtx),
    }),
    code_artifact: tool({
      description: codeArtifact.description,
      inputSchema: codeArtifact.inputSchema,
      execute: (input: { title: string; userPrompt: string }) => codeArtifact.execute(input, execCtx),
    }),
    python_coding: tool({
      description: pythonCoding.description,
      inputSchema: pythonCoding.inputSchema,
      execute: (input: { requirements: string }) => pythonCoding.execute(input, execCtx),
    }),
    make_it_real: tool({
      description: makeItReal.description,
      inputSchema: makeItReal.inputSchema,
      execute: (input: { instructions?: string; markdown: string }) => makeItReal.execute(input, execCtx),
    }),
    doc_compose: tool({
      description: docCompose.description,
      inputSchema: docCompose.inputSchema,
      execute: (input: { title: string; userPrompt: string }) => docCompose.execute(input, execCtx),
    }),
    bash: tool({
      description: bash.description,
      inputSchema: bash.inputSchema,
      execute: (input: { command: string }) => bash.execute(input, execCtx),
    }),
    browser_use: tool({
      description: browserUse.description,
      inputSchema: browserUse.inputSchema,
      execute: (input: { task: string }) => browserUse.execute(input, execCtx),
    }),
    list_files: tool({
      description: listFilesTool.description,
      inputSchema: listFilesTool.inputSchema,
      execute: (input: { path?: string }) => listFilesTool.execute(input, execCtx),
    }),
    // Credential vault + self-authored skills (2026-07-11) — see
    // apps/agent/agent/lib/credential-vault.ts and each tool-impl's own
    // comment. Registered here identically to every other tool above so
    // BYOK/Gateway-direct users get full parity with eve's default path.
    save_credential: tool({
      description: saveCredentialTool.description,
      inputSchema: saveCredentialTool.inputSchema,
      execute: (input: { service: string; label?: string; value: string }) => saveCredentialTool.execute(input, execCtx),
    }),
    list_credentials: tool({
      description: listCredentialsTool.description,
      inputSchema: listCredentialsTool.inputSchema,
      execute: () => listCredentialsTool.execute({}, execCtx),
    }),
    inject_credential: tool({
      description: injectCredentialTool.description,
      inputSchema: injectCredentialTool.inputSchema,
      execute: (input: { service: string; label?: string; envVarName: string }) => injectCredentialTool.execute(input, execCtx),
    }),
    create_skill: tool({
      description: createSkillTool.description,
      inputSchema: createSkillTool.inputSchema,
      execute: (input: { name: string; description: string; instructions: string }) => createSkillTool.execute(input, execCtx),
    }),
    list_skills: tool({
      description: listSkillsTool.description,
      inputSchema: listSkillsTool.inputSchema,
      execute: () => listSkillsTool.execute({}, execCtx),
    }),
    recall_skill: tool({
      description: recallSkillTool.description,
      inputSchema: recallSkillTool.inputSchema,
      execute: (input: { name: string }) => recallSkillTool.execute(input, execCtx),
    }),
    get_preview_url: tool({
      description: getPreviewUrlTool.description,
      inputSchema: getPreviewUrlTool.inputSchema,
      execute: () => getPreviewUrlTool.execute({}, execCtx),
    }),
    restart_sandbox: tool({
      description: restartSandboxTool.description,
      inputSchema: restartSandboxTool.inputSchema,
      execute: (input: { command?: string }) => restartSandboxTool.execute(input, execCtx),
    }),
  } as const;
  // Confirmed real bug (2026-07-11): this used to be sent as-is regardless
  // of the user's Tools menu picks — chat-input.tsx's onSend already
  // collected `disabledTools` and passed it all the way down, but this
  // route never read it off the body at all, so every turn always got
  // every single tool's full schema attached (unnecessary prompt/latency
  // overhead) AND a disabled tool could still be called by the model.
  const activeTools = Object.fromEntries(Object.entries(allTools).filter(([name]) => !disabledToolSet.has(name))) as typeof allTools;

  const result = streamText({
    model,
    stopWhen: stepCountIs(120), // generous ceiling so a long agentic turn is bounded by the 1800s time budget, not an arbitrary low step count
    messages: await modelMessages,
    // Anthropic-family models need extended thinking explicitly turned on
    // to produce reasoning tokens at all (unlike e.g. DeepSeek-R1/o-series,
    // which stream reasoning by default) — best-effort, ignored by any
    // model/provider that doesn't recognize it.
    // Portable across OpenAI, Anthropic, Google, xAI, Groq, DeepSeek,
    // Fireworks and Bedrock — strictly better than the old Anthropic-only
    // hardcoded `providerOptions.anthropic.thinking` budget hack it
    // replaced, and it actually honors the user's selected effort level
    // instead of a fixed, non-configurable 8000-token budget for Claude
    // only. See REASONING_LEVELS above for how the value is sourced.
    // Gated by `reasoningCapable` (see above) — never sent to a model that
    // doesn't actually support it, which used to hard-fail the whole turn
    // for some providers instead of just running at the model's default.
    reasoning: (await (async () => {
      const capable = await reasoningCapablePromise;
      // Temporary, cheap diagnostic — confirms which branch a real turn
      // actually took without needing to re-derive this from a debugger.
      // Safe to leave in permanently: one line, no PII beyond the model id
      // the user themselves picked.
      console.log('[direct chat] reasoning gate', { modelId, reasoningCapable: capable, effort: resolvedReasoningEffort });
      return capable;
    })()) ? resolvedReasoningEffort : 'provider-default',
    onError({ error }) {
      console.error('[direct chat] streamText error', chatId, providerLabel, modelId, error);
      logError({ source: 'direct-chat-streamtext', error, userId, chatId, context: { providerLabel, modelId } });
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
    // provider stream and re-emits it word-by-word on a fixed small delay
    // (AI SDK's own documented fix for exactly this complaint, see
    // ai-sdk.dev/docs/ai-sdk-core/streaming-text-generation#smoothing-the-stream)
    // -- decouples the visual cadence from the provider's actual chunk
    // boundaries so it always looks like a real, even stream no matter how
    // the upstream API batches it. Defaults (10ms/word) are the same ones
    // the AI SDK docs recommend for chat UIs.
    experimental_transform: smoothStream({ chunking: 'word' }),
  });

  // Make sure the durability write has actually landed before the
  // response goes out — this await runs concurrently with (not after)
  // streamText's own already-in-flight provider request above, so it's
  // essentially free: total added latency is whichever of the two is
  // slower, not their sum.
  await preSave;

  // Decouple the actual generation (model call + every tool call, incl.
  // bash/browser_use side effects) from whether the client's HTTP
  // connection stays open. Without this, a backgrounded mobile tab (OS
  // suspends its network activity) or a dropped Wi-Fi/cellular
  // connection tore down the underlying response stream, which by
  // default aborts the in-flight streamText call too -- onFinish below
  // never fires, nothing gets persisted, and the whole turn (including
  // any bash/browser_use work already done) is silently lost even though
  // none of it was actually the user's fault. `consumeStream()` reads
  // the result to completion on its own regardless of who else is
  // reading it, and `after()` guarantees that keeps running for the full
  // 1800s maxDuration budget even after this handler returns the
  // Response below -- so the turn always finishes and gets saved via
  // onFinish, and a client that reconnects (see direct-chat-interface.tsx's
  // online/visibilitychange recovery fetch) picks up the completed
  // result instead of a stalled/lost one.
  after(() =>
    Promise.resolve(result.consumeStream()).catch((err: unknown) => {
      console.error('[direct chat] background consumeStream failed', chatId, err);
      logError({ source: 'direct-chat-consumestream', error: err, userId, chatId, context: { providerLabel, modelId } });
    })
  );

  return result.toUIMessageStreamResponse({
    originalMessages: uiMessages,
    generateMessageId: () => crypto.randomUUID(),
    sendReasoning: true,
    onError(error) {
      // Default behavior swallows the real error into a generic "An error
      // occurred." with nothing else — confirmed cause of "tool calls fail
      // and the AI doesn't respond, no error even shown". Log the full
      // error server-side (console for a live tail + a durable DB row so
      // it's still findable after the fact, see logError's file comment)
      // and surface a real, readable message to the client instead.
      console.error('[direct chat] turn error', chatId, providerLabel, modelId, error);
      logError({ source: 'direct-chat-turn', error, userId, chatId, context: { providerLabel, modelId } });
      if (error instanceof Error) return error.message;
      if (typeof error === 'string') return error;
      return 'Something went wrong generating a response. Please try again.';
    },
    async onFinish({ messages: finalMessages }) {
      // Same repair as above, applied to what THIS turn is about to
      // persist — a stream cut off mid-tool-call (disconnect, crash, an
      // execute() that never resolves) would otherwise save a dangling
      // call right now and brick every future turn on this chat, exactly
      // the failure this whole file's sanitizer exists to prevent.
      const sanitizedFinalMessages = sanitizeDanglingToolCalls(finalMessages as UIMessage[]);
      await prisma.eveChatSession
        .update({ where: { id: chatId, userId }, data: { events: sanitizedFinalMessages as any } })
        .catch(err => {
          console.error('[direct chat] final save failed', chatId, err);
          logError({ source: 'direct-chat-final-save', error: err, userId, chatId });
        });
    },
    headers: {
      'x-direct-chat-session-id': chatId,
      'x-direct-chat-provider': providerLabel,
      'x-direct-chat-model': modelId,
    },
  });
});
