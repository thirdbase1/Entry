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
 * lib/direct-chat/sandbox.ts, a standalone E2B-backed wrapper (REWRITTEN
 * 2026-07-16 off its original `@vercel/sandbox` implementation — see that
 * file's comment for the confirmed real bug this fixed: this path had
 * silently never gotten eve's own Vercel-Sandbox-quota-driven E2B
 * migration, so BYOK/direct chats were still hitting Vercel's Hobby-plan
 * sandbox limits and a doubly-broken browser_use bootstrap) keyed by
 * chatId instead of an eve session id. Every tool execute is wrapped with safeExecute at the source
 * (lib/tool-impls/*.ts) so a thrown error (bad key, upstream outage, etc.)
 * always resolves to a normal `{ error }` tool result the model can see
 * and explain, instead of an uncaught rejection that can tear down the
 * whole in-flight stream — confirmed root cause of "tool calls make the
 * AI just stop" (PARALLEL_API_KEY was empty in production; fixed
 * separately, but the wrapper is what stops ANY tool's upstream failure
 * from doing the same thing again).
 */
import { NextRequest } from 'next/server';
import { waitUntil } from '@vercel/functions';

// Long autonomous agentic turns (many chained tool calls) need real
// runway, but the actual ceiling depends on the Vercel plan the project
// is deployed on, not just the platform's theoretical max: Hobby caps
// every Serverless Function at 300s (confirmed the hard way -- a live
// prod deploy was rejected outright with "Builder returned invalid
// maxDuration value ... must have a maxDuration between 1 and 300 for
// plan hobby" when this was set to 1800). 1800s is only reachable on
// Pro/Enterprise's "extended max duration" beta. 300 is the real,
// current ceiling for this project; genuinely unbounded (e.g. 50+
// minute) autonomous runs need Vercel Workflows' pause/resume
// durable-execution model instead of a plain function regardless of
// plan -- a real architecture change, not a config tweak (see chat
// about this if/when needed). Bump this back up if/when the project
// moves to Pro or above.
export const maxDuration = 300;
import {
  streamText,
  tool,
  stepCountIs,
  convertToModelMessages,
  smoothStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import { getUserSessionFromRequest } from '@entry/auth';
import { prisma } from '@entry/db';
import { logError } from '@entry/db/error-log';
import { captureVersionFromSandboxDiff } from '@entry/db/chat-versioning';
import { withApiErrorHandling } from '@/lib/api-error';
import { resolveByokModel } from '@/lib/byok/resolve-model';
import { resolveGatewayModel } from '@/lib/direct-chat/resolve-gateway-model';
import { getSandboxForChat } from '@/lib/direct-chat/sandbox';
import { sanitizeDanglingToolCalls } from '@/lib/direct-chat/sanitize-messages';
import { fillEmptyAssistantReply, describeRefusal } from '@/lib/direct-chat/fill-empty-refusal';
import { stripReasoningParts } from '@/lib/direct-chat/strip-reasoning-parts';
import { compactMessagesIfNeeded } from '@/lib/direct-chat/compact-messages';
import { applyToolCacheBreakpoint, buildCachedSystemMessage, applyConversationCacheControl } from '@/lib/direct-chat/prompt-cache';
import { buildPersonaInstructions } from '@entry/agent/lib/persona';

// Providers confirmed (from live prod error logs) to reliably 400 on the
// step-2+ request of an agentic turn -- i.e. their relay can't handle a
// follow-up call that carries a tool result back to the model, even
// though the initial tool-calling request itself works fine. Rather than
// remove/disable these (explicit user request: keep them usable for
// plain chat), direct-chat's prepareStep drops tool availability after
// the first step for anyone in this set -- see that callsite's comment
// for the full incident writeup. Keyed by providerLabel (exact,
// case-sensitive match to what resolveByokModel returns).
const FLAKY_PROVIDERS_DROP_TOOLS_AFTER_STEP_1 = new Set(['Woino']);
import type { ToolExecCtx } from '@entry/agent/tool-impls/types';

import { choose } from '@entry/agent/tool-impls/choose';
import { webCrawl } from '@entry/agent/tool-impls/web_crawl';
import { webSearch } from '@entry/agent/tool-impls/web_search';
import { taskAnalysis } from '@entry/agent/tool-impls/task_analysis';
import { codeArtifact } from '@entry/agent/tool-impls/code_artifact';
import { pythonCoding } from '@entry/agent/tool-impls/python_coding';
import { writeFileTool } from '@entry/agent/tool-impls/write_file';
import { editFileTool } from '@entry/agent/tool-impls/edit_file';
import { browserUse } from '@entry/agent/tool-impls/browser_use';
import { browserStop } from '@entry/agent/tool-impls/browser_stop';
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
import { agentDelegate } from '@entry/agent/tool-impls/agent';
import { rememberAboutUserTool } from '@entry/agent/tool-impls/remember_about_user';
import { getWorkingMemory } from '@entry/agent/lib/working-memory';
import { z } from 'zod';

// ENABLED (2026-07-15, user request): direct-chat now wires the real
// `agent` (sub-agent delegation) tool into its own `tools` object below,
// same implementation eve-root uses (@entry/agent/tool-impls/agent).
// This used to be deliberately left out -- the persona told the model it
// had NO delegation tool (`includeAgentDelegation: false`) specifically
// to avoid a real crash: telling a model about a tool that doesn't
// actually exist in its `tools` object causes AI_NoSuchToolError,
// killing the turn at step 0 with the tool call stuck unresolved forever
// (see persona.ts's file comment for the full incident). That workaround
// suppressed the mention instead of fixing the actual gap. Now that the
// tool is genuinely present below (respecting `disabledToolSet` like
// every other tool here, and `ctx.byokModel` so BYOK turns never touch
// the Gateway for it either -- same policy as every other sub-generation
// tool), it's safe to tell the model about it again.
export const POST = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const body = await req.json().catch(() => ({}));
  const { id, messages, byokModelId, requestedModel, disabledTools } = body ?? {};
  if (!byokModelId && !requestedModel) {
    return Response.json({ error: 'byokModelId or requestedModel is required' }, { status: 400 });
  }
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
  // See strip-reasoning-parts.ts's file comment for the exact bug this
  // fixes (only set on the BYOK path -- resolveGatewayModel's return type
  // has no such flag, always undefined/false there).
  const isThirdPartyResponsesRelay = 'isThirdPartyResponsesRelay' in resolved && resolved.isThirdPartyResponsesRelay;

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
      // FIXED (2026-07-15, real confirmed bug -- "why if I select another
      // model to work and when I reload page I see that it has already
      // automatically switched to [the chat's original model]"): this
      // used to only ever write byokModelId/requestedModel once, at
      // creation, in the `if (!existing)` branch above -- every later
      // turn only updated `events`. Switching models mid-thread already
      // worked live (see chat-interface.tsx's own 2026-07-11 fix for
      // "switch model, doesn't change, still uses the model I first
      // used") but the DB row itself never learned about it, so the very
      // next full page reload re-seeded the picker from that frozen,
      // creation-time value and silently reverted every later switch.
      // Now the row's stored model always reflects whichever one was
      // actually used for the MOST RECENT turn, matching what
      // chat-interface.tsx's seeding effect reads back on reload.
      await prisma.eveChatSession.update({
        where: { id: chatId, userId },
        data: { events: uiMessages as any, byokModelId: byokModelId ?? null, requestedModel: byokModelId ? null : (requestedModel ?? null) },
      });
    }
  })().catch(err => {
    console.error('[direct chat] pre-stream save failed', chatId, err);
    logError({ source: 'direct-chat-presave', error: err, userId, chatId });
  });

  // Minimal structural ctx — enough for the 10 reused tool-impls. See
  // ToolExecCtx: only `session.id` / `session.auth.current.principalId`
  // are read by most tools here (the sub-generation tools read
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
  // Fixed (2026-07-14, real production crash): the persona system prompt
  // AND the compaction summary below used to each be prepended INTO this
  // array as their own `role: 'system'` message. That's what this SDK's
  // `messages`/`prompt` validation flatly rejects by default -- confirmed
  // directly from node_modules/ai/dist/index.js: `if
  // (!allowSystemInMessages && messages.some(m => m.role === 'system'))
  // throw "System messages are not allowed in the prompt or messages
  // fields. Use the instructions option instead."` -- and confirmed as a
  // real live crash (AI_InvalidPromptError on every single turn for at
  // least one BYOK model, and would have resurfaced separately the first
  // time any chat got long enough to trigger compact-messages.ts's own
  // summary injection). The SDK's actual documented mechanism for a
  // system prompt that still needs providerOptions (cache_control
  // included) is the separate `instructions` param on streamText, which
  // explicitly accepts a SystemModelMessage or array of them for exactly
  // this case -- see node_modules/ai/dist/index.d.ts's own comment: "It
  // can be a string, or, if you need to pass additional provider options
  // (e.g. for caching), a SystemModelMessage." Both the persona prompt and
  // the (optional) compaction summary are combined into `instructions`
  // below instead of ever being spliced into `messages`.
  const messagesForModel = isThirdPartyResponsesRelay ? stripReasoningParts(uiMessages) : uiMessages;
  const compactionResult = compactMessagesIfNeeded(messagesForModel, model, modelId);
  const modelMessages = compactionResult.then(async ({ messages, wasCompacted }) => {
    if (wasCompacted) {
      console.log('[direct chat] compacted history before model call', { chatId, modelId, originalCount: uiMessages.length, sentCount: messages.length });
    }
    // Cache breakpoint on the last user+assistant turn -- so the growing
    // conversation history itself gets cached incrementally as the chat
    // gets longer -- see prompt-cache.ts's file comment for the full "why".
    const converted = await convertToModelMessages(messages);
    return applyConversationCacheControl(converted);
  });
  // REMOVED (2026-07-15, explicit user request): this used to pass
  // `runningAs: \`${providerLabel} · ${modelId}\`` here so the persona
  // prompt would tell the model exactly what it's running as. The user
  // does not want the model name/provider injected into the system
  // prompt at all -- identity questions should get whatever answer the
  // model naturally gives, with no steering either way. `providerLabel`/
  // `modelId` are still resolved above and still used for logging/
  // response headers, just no longer threaded into the prompt.
  const userWorkingMemory = await getWorkingMemory(userId);
  const SYSTEM_PROMPT = buildPersonaInstructions({ includeAgentDelegation: true, workingMemory: userWorkingMemory });
  const instructions = compactionResult.then(({ summaryText }) => {
    const systemMessage = buildCachedSystemMessage(SYSTEM_PROMPT);
    if (!summaryText) return systemMessage;
    // Plain string is fine for the summary -- it's regenerated (and its
    // text changes) each time compaction re-triggers, so there's no
    // stable prefix worth a cache_control breakpoint here the way there
    // is for the persona prompt above.
    return [systemMessage, { role: 'system' as const, content: summaryText }];
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
    write_file: tool({
      description: writeFileTool.description,
      inputSchema: writeFileTool.inputSchema,
      execute: (input: { path: string; content: string }) => writeFileTool.execute(input, execCtx),
    }),
    edit_file: tool({
      description: editFileTool.description,
      inputSchema: editFileTool.inputSchema,
      execute: (input: { path: string; old_text: string; new_text: string; replace_all?: boolean }) => editFileTool.execute(input, execCtx),
    }),
    bash: tool({
      description: bash.description,
      inputSchema: bash.inputSchema,
      execute: (input: { command: string }) => bash.execute(input, execCtx),
    }),
    browser_use: tool({
      description: browserUse.description,
      inputSchema: browserUse.inputSchema,
      execute: (input: { task: string; session_id?: string }) => browserUse.execute(input, execCtx),
    }),
    browser_stop: tool({
      description: browserStop.description,
      inputSchema: browserStop.inputSchema,
      execute: (input: { session_id: string }) => browserStop.execute(input, execCtx),
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
      execute: (input: { service: string; label?: string; envVarName: string; command: string }) => injectCredentialTool.execute(input, execCtx),
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
    // Sub-agent delegation -- see the ENABLED comment near this file's
    // imports for why this was missing before and why it's safe now.
    agent: tool({
      description: agentDelegate.description,
      inputSchema: agentDelegate.inputSchema,
      execute: (input: { message: string; provider?: string; model?: string }) => agentDelegate.execute(input, execCtx),
    }),
    // Durable per-user working memory (2026-07-18) -- see
    // UserWorkingMemory's schema comment and persona.ts's comment. Wired
    // identically to eve-root's copy (apps/agent/agent/tools/remember_about_user.ts)
    // so BYOK/Gateway-direct chats get the same "remember things about me
    // across sessions" capability as the default eve path.
    remember_about_user: tool({
      description: rememberAboutUserTool.description,
      inputSchema: rememberAboutUserTool.inputSchema,
      execute: (input: { action: 'read' | 'write'; content?: string }) => rememberAboutUserTool.execute(input, execCtx),
    }),
  } as const;
  // Confirmed real bug (2026-07-11): this used to be sent as-is regardless
  // of the user's Tools menu picks — chat-input.tsx's onSend already
  // collected `disabledTools` and passed it all the way down, but this
  // route never read it off the body at all, so every turn always got
  // every single tool's full schema attached (unnecessary prompt/latency
  // overhead) AND a disabled tool could still be called by the model.
  const activeTools = Object.fromEntries(Object.entries(allTools).filter(([name]) => !disabledToolSet.has(name))) as typeof allTools;

  // Tracked across steps so a fully-empty final turn (see
  // fill-empty-refusal.ts) can report WHY it was empty instead of just
  // silently patching in a generic message.
  let lastFinishReason: string | undefined;
  let lastRawFinishReason: string | undefined;

  const result = streamText({
    model,
    stopWhen: stepCountIs(120), // generous ceiling so a long agentic turn is bounded by the 1800s time budget, not an arbitrary low step count
    // See modelMessages' own comment above for why this (persona prompt +
    // optional compaction summary) moved here instead of being spliced
    // into `messages` as fake `role: 'system'` entries -- this is the
    // SDK's actual supported slot for a system prompt that also needs a
    // providerOptions/cache_control attachment.
    instructions: await instructions,
    messages: await modelMessages,
    // No client-side reasoning-effort control anymore (2026-07-15,
    // explicit removal request) -- every model just runs at its own
    // provider default reasoning behavior. `'provider-default'` is always
    // a safe no-op to pass regardless of whether the resolved model
    // actually supports extended reasoning at all (confirmed in this same
    // file's earlier investigation), so no per-model capability check is
    // needed here anymore either.
    reasoning: 'provider-default',
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
    prepareStep({ stepNumber }) {
      if (stepNumber > 0 && FLAKY_PROVIDERS_DROP_TOOLS_AFTER_STEP_1.has(providerLabel)) {
        return { activeTools: [] };
      }
      return {};
    },
    onError({ error }) {
      console.error('[direct chat] streamText error', chatId, providerLabel, modelId, error);
      logError({ source: 'direct-chat-streamtext', error, userId, chatId, context: { providerLabel, modelId } });
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
    onStepFinish(step) {
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
    experimental_transform: smoothStream({ chunking: 'word', delayInMs: 0 }),
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
  // 300s maxDuration budget (Hobby plan's ceiling) even after this handler returns the
  // Response below -- so the turn always finishes and gets saved via
  // onFinish, and a client that reconnects (see direct-chat-interface.tsx's
  // online/visibilitychange recovery fetch) picks up the completed
  // result instead of a stalled/lost one.
  // Switched next/server's after() -> @vercel/functions' raw waitUntil()
  // (2026-07-17). Live-fire tested against production: a real client
  // disconnect a few seconds into a tool call, with after()+consumeStream(),
  // reproducibly killed the turn outright -- onFinish never ran, nothing
  // persisted, no error even logged. Re-tested the identical scenario with
  // waitUntil() instead and the turn kept running server-side well past
  // the disconnect (confirmed via a durable DB checkpoint written mid-tool-
  // call, and separately by the run persisting for its full natural
  // duration up to the 300s ceiling instead of dying in the first few
  // seconds). Matches Vercel's own guidance for this exact case:
  // https://github.com/vercel/ai/issues/10844 -- "waitUntil() guarantees
  // the promise completes even after function termination," which is not
  // guaranteed for after() in the same way on this runtime.
  waitUntil(
    Promise.resolve(result.consumeStream()).catch((err: unknown) => {
      console.error('[direct chat] background consumeStream failed', chatId, err);
      logError({ source: 'direct-chat-consumestream', error: err, userId, chatId, context: { providerLabel, modelId } });
    })
  );

  const uiStream = result.toUIMessageStream({
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
      const sanitizedFinalMessages = fillEmptyAssistantReply(
        sanitizeDanglingToolCalls(finalMessages as UIMessage[]),
        lastFinishReason,
        lastRawFinishReason
      );
      await prisma.eveChatSession
        .update({ where: { id: chatId, userId }, data: { events: sanitizedFinalMessages as any } })
        .catch(err => {
          console.error('[direct chat] final save failed', chatId, err);
          logError({ source: 'direct-chat-final-save', error: err, userId, chatId });
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
      if (sandboxPromise) {
        const sandbox = await sandboxPromise;
        await captureVersionFromSandboxDiff(chatId, sandbox).catch(err => {
          console.error('[direct chat] version capture failed', chatId, err);
        });
      }
    },
  });

  // Confirmed real bug (2026-07-17): a turn can finish with zero text and
  // zero tool calls at all -- e.g. Anthropic returning
  // finishReason 'content-filter' / rawFinishReason 'refusal', a clean
  // model refusal that throws no exception at all. The AI SDK does not
  // treat this as an error (onError above never fires), so without this
  // wrapper the client sees total silence: the "Thinking…" indicator just
  // disappears and nothing ever replaces it. Every chunk is relayed
  // through unmodified while tracking whether ANYTHING real (visible text
  // or a tool call) was ever emitted; only if the whole stream ends
  // without any is a real text-start/text-delta/text-end chunk sequence
  // appended, explaining why -- same wording fillEmptyAssistantReply
  // already persisted server-side above, so a page refresh shows the
  // identical message instead of it vanishing.
  let sawRealContent = false;
  const wrappedStream = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      try {
        for await (const chunk of uiStream) {
          if (chunk.type === 'text-delta' && chunk.delta.trim().length > 0) {
            sawRealContent = true;
          } else if (chunk.type.startsWith('tool-')) {
            sawRealContent = true;
          }
          controller.enqueue(chunk);
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      if (!sawRealContent) {
        const id = crypto.randomUUID();
        const fallbackText = describeRefusal(lastFinishReason, lastRawFinishReason);
        controller.enqueue({ type: 'text-start', id });
        controller.enqueue({ type: 'text-delta', id, delta: fallbackText });
        controller.enqueue({ type: 'text-end', id });
      }
      controller.close();
    },
  });

  return createUIMessageStreamResponse({
    stream: wrappedStream,
    headers: {
      'x-direct-chat-session-id': chatId,
      'x-direct-chat-provider': providerLabel,
      'x-direct-chat-model': modelId,
    },
  });
});
