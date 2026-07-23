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

// REMOVED (2026-07-23) the stale `export const maxDuration = 300` that
// used to live here. That's a Vercel-only build-time directive -- Next.js
// itself never reads or enforces it at runtime (confirmed by grepping
// the actual request-serving code in node_modules/next/dist; every hit
// for "maxDuration" lives only in build/typegen files, never in
// next-server.js/base-server.js/route-modules). Since this route moved
// to Render 2026-07-22 (persistent server, no serverless duration cap at
// all), the constant was already 100% inert dead code -- kept only as a
// misleading relic of the old Vercel deploy that made this route look
// artificially capped at 300s when nothing was actually enforcing that
// anymore. The route's real ceiling is SOFT_DEADLINE_MS below (20 min).
import {
  streamText,
  tool,
  stepCountIs,
  convertToModelMessages,
  smoothStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
  InvalidToolInputError,
  type UIMessage,
  type UIMessageChunk,
  type AsyncIterableStream,
} from 'ai';
import { getUserSessionFromRequest } from '@entry/auth';
import { prisma } from '@entry/db';
import { logError } from '@entry/db/error-log';
import { captureVersionFromSandboxDiff } from '@entry/db/chat-versioning';
import { recordUsageEvent } from '@entry/db/usage-metering';
import { withApiErrorHandling } from '@/lib/api-error';
import { resolveByokModel } from '@/lib/byok/resolve-model';
import { resolveGatewayModel } from '@/lib/direct-chat/resolve-gateway-model';
import { resolveModelIdForProvider } from '@entry/agent/lib/model-catalog';
import { getSandboxForChat } from '@/lib/direct-chat/sandbox';
import { sanitizeDanglingToolCalls } from '@/lib/direct-chat/sanitize-messages';
import { fillEmptyAssistantReply, describeRefusal } from '@/lib/direct-chat/fill-empty-refusal';
import { mergeAndPersistChatEvents } from '@/lib/direct-chat/persist-chat-events';
import { stripReasoningParts } from '@/lib/direct-chat/strip-reasoning-parts';
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
import { readFileTool } from '@entry/agent/tool-impls/read_file';
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
  // No explicit model picked (byokModelId/requestedModel both absent) --
  // this is the "Default" chat bucket, formerly eve's root-agent path
  // (apps/agent/agent/agent.ts's fixed `model:`). Same Gateway-routed,
  // catalog-resolved model eve always picked (see model-catalog.ts's
  // resolveModelIdForProvider), just resolved here instead, so this one
  // route now serves every chat -- eve is no longer in the loop at all
  // (see DEPLOY.md / ROADMAP for the removal writeup).
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

  // BYOK TTFT FIX (2026-07-19): resolving a BYOK model reads/decrypts its
  // provider row, while Working Memory is a completely independent user
  // read. Starting the latter only AFTER `await resolveByokModel()` made
  // every direct/BYOK send pay those two DB operations serially before
  // `streamText()` could open the provider connection. Start it as soon as
  // userId exists; it is still awaited before the system prompt is built,
  // so neither prompt contents nor error behavior changes -- only the
  // otherwise-wasted wall-clock overlap does.
  const userWorkingMemoryPromise = getWorkingMemory(userId);

  const chatId = typeof id === 'string' && id ? id : crypto.randomUUID();

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
  try {
    resolved = byokModelId
      ? await resolveByokModel(byokModelId, userId)
      : requestedModel
        ? resolveGatewayModel(requestedModel)
        : resolveGatewayModel(await resolveModelIdForProvider('anthropic'));
  } catch (err) {
    await preSave;
    throw err;
  }
  const { model, providerLabel, modelId } = resolved;
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

  // See strip-reasoning-parts.ts's file comment for the exact bug this
  // fixes (only set on the BYOK path -- resolveGatewayModel's return type
  // has no such flag, always undefined/false there).
  const isThirdPartyResponsesRelay = 'isThirdPartyResponsesRelay' in resolved && resolved.isThirdPartyResponsesRelay;
  // FIXED (2026-07-19): same relay-imitating-a-real-provider problem, just
  // on ANTHROPIC compatibility mode instead of OPENAI_RESPONSES -- see
  // resolve-model.ts's isThirdPartyAnthropicRelay comment for the exact
  // "unsupported reasoning metadata" warning-storm bug this closes.
  const isThirdPartyAnthropicRelay = 'isThirdPartyAnthropicRelay' in resolved && resolved.isThirdPartyAnthropicRelay;

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
  // REMOVED (2026-07-23, explicit user request): context compaction
  // (compact-messages.ts) used to summarize older turns via an extra
  // `generateText` call once history got large, to protect against
  // exceeding a model's context window on very long sessions. Removed
  // because it added a second, independent point of failure to every
  // long-running chat turn (a real, confirmed-live case: the summary
  // call itself 403'd with "account tier is insufficient" against a
  // BYOK provider account) -- and per-turn simplicity/predictability was
  // judged more valuable than the (already-rare, always-fail-safe)
  // context-window protection it gave. `uiMessages` is now sent to the
  // model as-is, full raw history every turn, same as before this
  // feature existed on 2026-07-14. If a genuinely long session ever hits
  // a real "context length exceeded" error from a provider, that's a
  // normal, visible, catchable onError case (unlike the silent risk this
  // feature carried) -- reintroduce compaction deliberately later if that
  // becomes a real recurring complaint, not as a blanket default.
  const messagesForModel = (isThirdPartyResponsesRelay || isThirdPartyAnthropicRelay) ? stripReasoningParts(uiMessages) : uiMessages;
  const modelMessages = (async () => {
    // Cache breakpoint on the last user+assistant turn -- so the growing
    // conversation history itself gets cached incrementally as the chat
    // gets longer -- see prompt-cache.ts's file comment for the full "why".
    const converted = await convertToModelMessages(messagesForModel);
    return applyConversationCacheControl(converted);
  })();
  // REMOVED (2026-07-15, explicit user request): this used to pass
  // `runningAs: \`${providerLabel} · ${modelId}\`` here so the persona
  // prompt would tell the model exactly what it's running as. The user
  // does not want the model name/provider injected into the system
  // prompt at all -- identity questions should get whatever answer the
  // model naturally gives, with no steering either way. `providerLabel`/
  // `modelId` are still resolved above and still used for logging/
  // response headers, just no longer threaded into the prompt.
  const userWorkingMemory = await userWorkingMemoryPromise;
  // NOTE (2026-07-19): `instructions` is now built AFTER `activeTools`
  // below so the persona prompt can embed the real post-filter tool-name
  // list (see persona.ts's availableTools) — it's only consumed by
  // streamText much further down.

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
    read_file: tool({
      description: readFileTool.description,
      inputSchema: readFileTool.inputSchema,
      execute: (input: { path: string; startLine?: number; endLine?: number }) => readFileTool.execute(input, execCtx),
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

  // Persona prompt grounded in the REAL tool list for this exact session
  // (post Tools-menu filtering) — see persona.ts's availableTools
  // comment: an authoritative name list prevents the hallucinated-tool
  // class of failure (the `todo` incident, 2026-07-15) up front instead
  // of at AI_NoSuchToolError time. This is why the block moved down here
  // from its old spot above `allTools`.
  const SYSTEM_PROMPT = buildPersonaInstructions({
    includeAgentDelegation: true,
    workingMemory: userWorkingMemory,
    availableTools: Object.keys(activeTools),
  });
  // Compaction removed (see above) -- instructions is now just the
  // persona system prompt, no async summary branch to fold in anymore.
  const instructions = Promise.resolve(buildCachedSystemMessage(SYSTEM_PROMPT));

  // Tracked across steps so a fully-empty final turn (see
  // fill-empty-refusal.ts) can report WHY it was empty instead of just
  // silently patching in a generic message.
  let lastFinishReason: string | undefined;
  let lastRawFinishReason: string | undefined;
  let stepCount = 0;
  // Soft, in-process deadline INSIDE the sync route's own 300s Vercel
  // ceiling (2026-07-21) -- mirrors agent-turn.ts's identical pattern for
  // the durable worker's 3600s ceiling, just scaled to this route's much
  // tighter budget. 230s leaves ~70s of real headroom for the current
  // step's model call to actually finish, onFinish's persistence/version-
  // capture work, and the background-handoff trigger call below, all
  // before Vercel's hard 300s kill (which -- same as agent-turn.ts's
  // comment on its own hard ceiling -- would otherwise leave onFinish
  // never running at all).
  const requestStartedAt = Date.now();
  // Render (persistent server, no serverless 300s kill) replaced Vercel for
  // this route 2026-07-22 -- raised from 230_000 (which existed purely to
  // leave margin under Vercel's hard 300s ceiling) since that constraint is
  // gone. Still finite so a genuinely runaway turn eventually wraps up in
  // text instead of never stopping.
  const SOFT_DEADLINE_MS = 3_300_000;
  let softDeadlineHit = false;

  // CRITICAL-SAVE GATE (2026-07-19, real data-loss bug: "agent done and
  // stop, instantly the whole page reload, and all AI response and work
  // didn't show at all, only my prompt show"). Root cause, confirmed by
  // reading node_modules/ai/dist/index.js directly: `toUIMessageStream`'s
  // own `onFinish` (below, which does the actual
  // `prisma.eveChatSession.update` save) is wired through
  // `handleUIMessageStreamFinish` to fire from a TransformStream's
  // `flush()` -- which only runs AFTER every real chunk, INCLUDING the
  // `type: 'finish'` chunk that tells the browser's `useChat` the turn is
  // over, has already been enqueued and is already readable by whatever
  // consumes this stream. So the client can see "done", flip back to
  // 'ready', fire ITS OWN onFinish (which does `router.replace` to this
  // chat's permanent URL for a brand-new chat's first turn), and that new
  // page can re-fetch the persisted session from Postgres -- all before
  // this route's own `onFinish` below has even STARTED writing the full
  // transcript. Landing on that fresh fetch mid-race reads exactly what
  // `preSave` wrote earlier (the user's message only), which is exactly
  // "only my prompt show[s]." The slower `captureVersionFromSandboxDiff`
  // runs (git lock contention, an unexpected nested-repo/gitlink path,
  // etc.), the WIDER this race window gets, which is why it started
  // showing up around the same time as those git errors.
  //
  // Fix: hold the client-visible `finish` chunk in the relay loop below
  // until the CRITICAL save (the actual events write, not the best-effort
  // versioning that follows it) has durably completed. `resolveCriticalSave`
  // is called the instant that `prisma.eveChatSession.update` settles
  // (success OR failure -- a failed save has nothing better to wait for,
  // and the in-memory stream content the client already built itself is
  // still correct either way; this gate only protects against navigating
  // onto a STALE fetch, not against a genuine DB outage). Bounded by
  // CRITICAL_SAVE_TIMEOUT_MS as a safety valve so a truly hung DB
  // connection can never hang the user-visible end of the turn forever --
  // same "always eventually forward" philosophy as HEARTBEAT_MS below.
  let resolveCriticalSave: () => void = () => {};
  const criticalSaveDone = new Promise<void>(resolve => {
    resolveCriticalSave = resolve;
  });

  const result = streamText({
    model,
    stopWhen: stepCountIs(400), // generous ceiling so a long agentic turn is bounded by the SOFT_DEADLINE_MS time budget, not an arbitrary low step count
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
    // SOFT_DEADLINE_MS's 20-minute budget above (so onFinish/version-
    // capture/save still always gets to run afterward either way).
    // Deliberately scoped to "no data at all for 4 minutes", not a cap on
    // total step duration -- a model that's genuinely still producing
    // output stays completely unaffected no matter how long that takes;
    // only a truly dead connection gets cut. stepMs is a secondary safety
    // net for the "trickles a few bytes forever but never finishes"
    // variant, raised proportionally, still comfortably under
    // SOFT_DEADLINE_MS so there's real margin for onFinish/version-
    // capture/save work to run afterward.
    timeout: { chunkMs: 240_000, stepMs: 600_000 },
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
      // SOFT DEADLINE (bumped 20min -> 55min, 2026-07-23, real ask: "fix
      // entry so model can do a very long task" -- e.g. a full admin-page
      // build in one continuous turn). STALE COMMENT REMOVED: the previous
      // version of this comment (2026-07-21) said onFinish "hands whatever's
      // left off to the durable Trigger.dev worker" -- that entire
      // Trigger.dev handoff path was retired 2026-07-22 when this route
      // moved to Render (see onFinish's own 2026-07-22 comment below, which
      // already correctly says "No Trigger.dev dependency anywhere in this
      // path" -- this comment just hadn't caught up to that yet). There is
      // no background handoff of any kind here: once past SOFT_DEADLINE_MS,
      // tools are dropped on the NEXT step so the model wraps up in plain
      // text instead of starting new tool work with no deadline at all --
      // durability of everything done so far is handled entirely by the
      // incremental per-step saves (see onStepEnd below), and the user can
      // send another message to continue past this point if the task
      // genuinely wasn't done yet. Render itself has no hard request-kill
      // like Vercel's old 300s ceiling, so this number is now a deliberate
      // choice (not a platform constraint) -- kept finite so a genuinely
      // runaway turn still wraps up eventually instead of running forever.
      if (Date.now() - requestStartedAt > SOFT_DEADLINE_MS) {
        softDeadlineHit = true;
        return { activeTools: [] };
      }
      return {};
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
      // CLEANED UP (2026-07-23, "we ain't using vercel anymore everything
      // is in render"): this used to be wrapped in @vercel/functions'
      // waitUntil(), a Vercel-serverless-only primitive whose entire job
      // is telling THAT platform not to freeze/kill a function instance
      // before a background promise settles. On Render -- a persistent
      // Node process that's never frozen between requests -- it was
      // already a silent no-op (confirmed straight from the installed
      // package: waitUntil() looks up a `Symbol.for('@vercel/request-
      // context')` global that only Vercel's own runtime ever injects;
      // on any other platform that lookup returns nothing and the whole
      // call is skipped). It was harmless dead weight either way, since
      // the promise below is constructed eagerly -- calling
      // recordUsageEvent(...) starts the DB write immediately regardless
      // of what wraps it -- but leaving Vercel-specific framing in a
      // Render-only codebase is exactly the kind of stale assumption
      // worth deleting outright rather than stepping around. Plain
      // fire-and-forget with its own `.catch` is all that's needed here.
      // Usage shape verified against THIS repo's installed ai package
      // (LanguageModelUsage): cache reads/writes live in
      // usage.inputTokenDetails, not in providerMetadata.
      if (usage && (usage.inputTokens != null || usage.outputTokens != null)) {
        void recordUsageEvent({
          userId,
          chatId,
          source: 'direct-chat',
          model: modelId,
          provider: byokModelId ? `byok:${providerLabel}` : 'gateway',
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
      if (sandboxPromise && toolCalls.length > 0) {
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
        void sandboxPromise.then(sandbox =>
          // skipCard=true: the card must only be appended AFTER onFinish
          // persists the final sanitized messages -- appending it here races
          // with that write and causes the card to be overwritten (the card
          // lands in events, then onFinish overwrites events with
          // sanitizedFinalMessages which has no card). The version rows
          // (ChatVersion/ChatVersionFile) are still written here for
          // incremental durability; only the UI card is deferred.
          captureVersionFromSandboxDiff(chatId, sandbox, { skipCard: true })
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
  // connection tearing down the underlying response stream could abort
  // the in-flight streamText call too -- onFinish below never fires,
  // nothing gets persisted, and the whole turn (including any
  // bash/browser_use work already done) is silently lost even though
  // none of it was actually the user's fault. `result.consumeStream()`
  // reads the result to completion on its own regardless of who else is
  // (or isn't) still reading the outer Response's stream -- so the turn
  // always finishes and gets saved via onFinish, and a client that
  // reconnects (see direct-chat-interface.tsx's stall-detection recovery
  // fetch) picks up the completed result instead of a stalled/lost one.
  //
  // CLEANED UP (2026-07-23, "we ain't using vercel anymore everything is
  // in render"): this used to be wrapped in @vercel/functions' raw
  // waitUntil(), carried over from back when this ran on Vercel
  // serverless (2026-07-17 history: after() there demonstrably killed
  // the turn on a real client disconnect, waitUntil() didn't -- because
  // Vercel can freeze/tear down a function instance the moment its
  // Response finishes unless something explicitly holds it open, which
  // is the ONE thing waitUntil() exists to do on that platform).
  // On Render that entire problem class doesn't exist: this is a plain
  // persistent Node process, never frozen between requests, so ANY
  // already-in-flight promise -- like the one `result.consumeStream()`
  // returns below -- just keeps running for as long as the event loop
  // keeps ticking, which on a live server is always. waitUntil() itself
  // had already become a complete no-op here days before this cleanup
  // (confirmed straight from the installed package: it looks up a
  // `Symbol.for('@vercel/request-context')` global that only Vercel's
  // own runtime ever injects -- on Render that lookup returns nothing
  // and the call is silently skipped), so removing the wrapper changes
  // no actual runtime behavior; it only removes a misleading, now-false
  // "this needs Vercel to work" implication from code that's been
  // running on Render since 2026-07-22.
  Promise.resolve(result.consumeStream()).catch((err: unknown) => {
    console.error('[direct chat] background consumeStream failed', chatId, err);
    logError({ source: 'direct-chat-consumestream', error: err, userId, chatId, context: { providerLabel, modelId } });
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
    messageMetadata({ part }) {
      if (part.type === 'finish') {
        return { durationMs: Date.now() - requestStartedAt };
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
      // RACE-SAFE (2026-07-23, see persist-chat-events.ts's file comment):
      // used to be a blind `update({ data: { events: sanitizedFinalMessages } })`
      // built from THIS request's own request-start `uiMessages` snapshot --
      // clobbered anything a concurrent turn on the same chatId had
      // already committed since then. `uiMessages` (this turn's own
      // baseline) vs `sanitizedFinalMessages` (baseline + this turn's own
      // new reply) gives mergeAndPersistChatEvents an exact delta to
      // append onto the row's actual current state instead of overwriting it.
      await mergeAndPersistChatEvents(chatId, userId, uiMessages, sanitizedFinalMessages)
        .catch(err => {
          console.error('[direct chat] final save failed', chatId, err);
          logError({ source: 'direct-chat-final-save', error: err, userId, chatId });
        })
        .finally(() => {
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
      if (sandboxPromise) {
        const sandbox = await sandboxPromise;
        await captureVersionFromSandboxDiff(chatId, sandbox).catch(err => {
          console.error('[direct chat] version capture failed', chatId, err);
        });
      }

      // NOTE (2026-07-22, Render migration -- user explicitly wants Render-only,
      // no Trigger.dev): this app now runs on Render (a persistent server, not
      // Vercel serverless), so there's no hard 300s kill forcing a background
      // handoff anymore -- the turn just keeps running in this same process
      // until it genuinely finishes (see SOFT_DEADLINE_MS/stepCountIs(120) above,
      // both raised generously now that there's no platform timeout to race).
      // `finishedNaturally` is kept only as an observability signal for the rare
      // case a turn still hits the step cap or gets cut mid-tool-call --
      // `sanitizedFinalMessages` is already durably persisted above either way,
      // so the user can just send another message ("continue") to pick up from
      // the real last checkpoint. No Trigger.dev dependency anywhere in this path.
      const finishedNaturally = !softDeadlineHit && stepCount < 120 && lastFinishReason !== 'tool-calls';
      if (!finishedNaturally) {
        console.log('[direct chat] turn ended without a natural finish (rare -- user can send "continue")', { chatId, softDeadlineHit, stepCount, lastFinishReason });
      }
    },
  });

  // INCREMENTAL DURABILITY (2026-07-23, real user-confirmed bug, with
  // screenshots: a tool call visibly shown mid-turn, the server process
  // dies (Render's health-check kill -- confirmed straight from Render's
  // own service events API: repeated `server_failed` / `unhealthy: "HTTP
  // health check failed (timed out after 5 seconds)"` events on this
  // exact service), a reload lands on a dead instance for a few seconds
  // (the "this site can't be reached" page from the screenshots), and
  // once Render brings a fresh instance up the chat loads again but that
  // tool call is just GONE -- not overwritten (that race is fixed
  // separately, see persist-chat-events.ts), genuinely never saved in the
  // first place. Root cause: before this, `events` only ever got written
  // twice per turn -- preSave (before the model even runs) and onFinish
  // (only reached if the ENTIRE turn completes normally, i.e. never
  // reached at all on a hard kill). Everything in between -- every
  // intermediate tool call, every step's text -- lived ONLY in this
  // in-flight stream and the client's in-memory React state. A hard kill
  // anywhere in that window (a Render health-check kill, a crash, an OOM,
  // a deploy restart mid-turn) took all of it down too, even though it
  // had already rendered live in the UI.
  //
  // `result.toUIMessageStream()`'s own options do NOT expose a per-step
  // hook (only `onEnd`/`onFinish`, confirmed directly against
  // UIMessageStreamOptions in ai/dist/index.d.ts) -- but the standalone
  // `createUIMessageStream()` builder does, via `onStepEnd`
  // ("useful for persisting intermediate UI messages during multi-step
  // agent runs", straight from its own doc comment -- built for exactly
  // this). Wrapping `innerUiStream` here via `writer.merge()` costs
  // nothing extra: `createUIMessageStream`'s `merge()` just pipes the
  // exact same chunks straight through unmodified (confirmed reading
  // node_modules/ai/dist/index.js directly -- merge() is a bare
  // read-loop that re-enqueues each chunk as-is), while its OWN
  // `handleUIMessageStreamFinish` -- the same internal function backing
  // `onFinish` everywhere else in this SDK -- independently watches those
  // same chunks for step boundaries and reconstructs a full
  // originalMessages+response-so-far UIMessage[] at each one. Fire-and-
  // forget deliberately, same reasoning as the incremental version-
  // capture call in onStepFinish below: this must never gate the model's
  // next step on a DB round-trip (that exact mistake was already found
  // and fixed once for version-capture in 2026-07-23 -- "slow after
  // every tool call"). Safe to fire without awaiting because
  // mergeAndPersistChatEvents' row lock (`FOR UPDATE`) serializes
  // concurrent writes to the same chatId at the actual Postgres level,
  // not in JS -- overlapping incremental saves (or one racing the final
  // onFinish save above) still resolve correctly and in commit order no
  // matter what order these fire in from Node's side.
  // THROTTLED (2026-07-23, real evidence found in Render's own logs after
  // shipping the fix above: chat `TeafTQB7JaeLjQrw` -- one of the chats
  // that was actually crashing -- runs at 370,000+ input tokens PER STEP
  // and fires several tool calls back-to-back in rapid succession (bash,
  // bash, bash, edit_file, all within single-digit seconds of each
  // other). Every incremental save writes the chat's ENTIRE growing
  // `events` JSONB column back to Postgres -- for a chat this size that's
  // a multi-megabyte write, and saving after LITERALLY every step on a
  // fast tool-call sequence stacks several of those writes back-to-back
  // on the same connection pool. A genuine `Connection terminated due to
  // connection timeout` error is sitting in the logs in the exact same
  // window as the health-check kills -- unthrottled per-step saves on a
  // chat this large would make that contention WORSE, not better, which
  // defeats the whole point of this fix. Time-throttling to at most once
  // every 3s (per request) keeps the "nothing shown ever disappears"
  // guarantee -- 3s of a tool-heavy turn is a far smaller loss window
  // than "the entire rest of the turn", which is what was happening
  // before any of this -- while cutting DB write volume on big chats by
  // roughly an order of magnitude. onFinish above still runs its own
  // unconditional final save regardless of this throttle, so the very
  // last step of a turn is never skipped.
  let lastIncrementalSaveAt = 0;
  const INCREMENTAL_SAVE_MIN_INTERVAL_MS = 3_000;
  const uiStream = createUIMessageStream<UIMessage>({
    originalMessages: uiMessages,
    onStepEnd: ({ messages }) => {
      const now = Date.now();
      if (now - lastIncrementalSaveAt < INCREMENTAL_SAVE_MIN_INTERVAL_MS) return;
      lastIncrementalSaveAt = now;
      mergeAndPersistChatEvents(chatId, userId, uiMessages, messages).catch(err => {
        console.error('[direct chat] incremental step save failed', chatId, err);
        logError({ source: 'direct-chat-incremental-save', error: err, userId, chatId });
      });
    },
    execute: ({ writer }) => {
      writer.merge(innerUiStream);
    },
  }) as AsyncIterableStream<UIMessageChunk>;
  // ^ Type-only cast: `createUIMessageStream`'s return type is a plain
  // `ReadableStream` in the SDK's own .d.ts (unlike `result.toUIMessageStream()`,
  // typed as `AsyncIterableStream`), but Node's native ReadableStream
  // (Web Streams API, global since Node 18) always implements
  // `Symbol.asyncIterator` at runtime regardless of which SDK helper
  // constructed it -- confirmed directly: `innerUiStream` below already
  // relied on the exact same runtime behavior before this change existed.

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
  // HEARTBEAT KEEP-ALIVE (2026-07-18, user-reported: "still have streaming
  // problems" -- confirmed real gap: a long silent tool call (bash,
  // browser_use) can legitimately run for well over a minute with ZERO
  // stream bytes emitted in between -- the model has nothing to say until
  // the tool result comes back. An idle HTTP connection with no bytes
  // flowing for that long is exactly the shape corporate proxies, some
  // CDNs, and plenty of mobile carrier gateways kill outright (commonly a
  // 60-120s no-data timeout), which reads to the user as "streaming just
  // stopped/hung" even though the server is still working fine -- the
  // connection itself died underneath it. Racing the next real chunk
  // against a 15s timer and emitting a `type: 'custom'` chunk (the SDK's
  // own documented safe no-op passthrough type, see UIMessageChunk in
  // ai/dist/index.d.ts -- the client's tool/message switch only handles
  // known types, so an unrecognized `kind` here is silently ignored, not
  // an error) keeps real bytes flowing during any silent gap without
  // ever touching the actual model/tool content.
  const HEARTBEAT_MS = 15_000;
  // Safety valve for the CRITICAL-SAVE GATE above -- a real DB outage
  // should delay the client seeing "done" by at most this long, never
  // forever. 5s is generous headroom over the single-row conditional
  // UPDATE this is actually waiting on (a few ms to a couple hundred ms
  // in the normal case) while still being short enough nobody would
  // perceive it as a hang.
  const CRITICAL_SAVE_TIMEOUT_MS = 5_000;
  const wrappedStream = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const iterator = uiStream[Symbol.asyncIterator]();
      try {
        // IMPORTANT: `iterator.next()` must only ever be called ONCE per
        // actual value -- calling it again while a previous call is still
        // pending (e.g. naively re-calling it on every heartbeat timeout)
        // would race two concurrent reads against the same underlying
        // stream reader, which is not a safe/supported pattern. The fix:
        // keep reusing the SAME in-flight `pending` promise across as
        // many heartbeat timeouts as it takes, only replacing it once it
        // actually resolves with a real value.
        let pending = iterator.next();
        while (true) {
          // `clearTimeout` below matters, not just tidiness: without it, a
          // fast-arriving stream (plenty of quick text-deltas) would spawn
          // a fresh un-cancelled 15s timer on EVERY single chunk, each one
          // still firing (and resolving an otherwise-abandoned Promise)
          // long after it was made irrelevant by a real chunk already
          // winning the race -- accumulating timer garbage for the
          // duration of a long, chatty reply for no benefit.
          let timeoutId: ReturnType<typeof setTimeout>;
          const timeout = new Promise<'timeout'>(resolve => {
            timeoutId = setTimeout(() => resolve('timeout'), HEARTBEAT_MS);
          });
          const raced = await Promise.race([pending, timeout]);
          clearTimeout(timeoutId!);
          if (raced === 'timeout') {
            controller.enqueue({ type: 'custom', kind: 'entry.heartbeat' });
            continue;
          }
          const { value: chunk, done } = raced;
          if (done) break;
          pending = iterator.next();
          if (chunk.type === 'text-delta' && chunk.delta.trim().length > 0) {
            sawRealContent = true;
          } else if (chunk.type.startsWith('tool-')) {
            sawRealContent = true;
          }
          if (chunk.type === 'finish') {
            // See CRITICAL-SAVE GATE comment near `criticalSaveDone`'s
            // declaration above -- this is the exact chunk that tells the
            // browser's `useChat` the turn is over, so it's the one chunk
            // that must never reach the client before the real transcript
            // save has landed.
            await Promise.race([
              criticalSaveDone,
              new Promise<void>(resolve => setTimeout(resolve, CRITICAL_SAVE_TIMEOUT_MS)),
            ]);
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
      // ANTI-BUFFERING (2026-07-18, same "still have streaming problems"
      // report): without an explicit no-cache/no-transform signal, some
      // intermediary (a corporate proxy, some CDN configurations, even
      // certain reverse-proxy defaults) will buffer the ENTIRE response
      // before releasing any of it -- which looks identical to "not
      // streaming at all" client-side even though the server emitted
      // every chunk incrementally as intended. `X-Accel-Buffering: no` is
      // the standard signal nginx-family proxies specifically respect to
      // disable this; `Cache-Control`/`Connection` reinforce the same
      // intent for anything else in the path. Harmless no-ops for a
      // request that was never going to be buffered in the first place.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
