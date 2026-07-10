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
 * Tool parity: 8 of the 9 tools eve's root agent has (browser_use is the
 * one exception — it needs ctx.getSandbox(), which only exists inside an
 * authored eve runtime execution; out of scope here, fast-follow if
 * needed). Every tool execute is wrapped with safeExecute at the source
 * (lib/tool-impls/*.ts) so a thrown error (bad key, upstream outage, etc.)
 * always resolves to a normal `{ error }` tool result the model can see
 * and explain, instead of an uncaught rejection that can tear down the
 * whole in-flight stream — confirmed root cause of "tool calls make the
 * AI just stop" (PARALLEL_API_KEY was empty in production; fixed
 * separately, but the wrapper is what stops ANY tool's upstream failure
 * from doing the same thing again).
 */
import { NextRequest } from 'next/server';

// Long autonomous agentic turns (many chained tool calls) need real runway,
// not the Next.js/Vercel default 300s. 1800s is the current hard ceiling
// Vercel allows at all (Pro/Enterprise "extended max duration" beta) — a
// single HTTP function invocation cannot run longer than that on this
// platform today, full stop; genuinely unbounded (e.g. 50+ minute)
// autonomous runs need Vercel Workflows' pause/resume durable-execution
// model instead of a plain function, which is a real architecture change,
// not a config tweak (see chat about this if/when needed).
export const maxDuration = 1800;
import { streamText, tool, stepCountIs, convertToModelMessages, type UIMessage } from 'ai';
import { getUserSessionFromRequest } from '@entry/auth';
import { prisma } from '@entry/db';
import { withApiErrorHandling } from '@/lib/api-error';
import { resolveByokModel } from '@/lib/byok/resolve-model';
import { resolveGatewayModel } from '@/lib/direct-chat/resolve-gateway-model';
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

const SYSTEM_PROMPT = buildPersonaInstructions();

export const POST = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const body = await req.json().catch(() => ({}));
  const { id, messages, byokModelId, requestedModel, reasoningEffort } = body ?? {};
  if (!byokModelId && !requestedModel) {
    return Response.json({ error: 'byokModelId or requestedModel is required' }, { status: 400 });
  }
  // Portable AI SDK v7 top-level `reasoning` control (see
  // ai-sdk.dev/docs/ai-sdk-core/reasoning) — safe to pass for any model:
  // providers that don't support reasoning just ignore it with a warning.
  // Only ever trust one of the 5 known levels from the client; anything
  // else (missing, stale localStorage value, tampering) falls back to
  // 'provider-default' rather than erroring the whole turn.
  const REASONING_LEVELS = new Set(['none', 'low', 'medium', 'high', 'provider-default']);
  const resolvedReasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'provider-default' = REASONING_LEVELS.has(
    reasoningEffort
  )
    ? reasoningEffort
    : 'provider-default';
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'messages is required' }, { status: 400 });
  }
  const uiMessages = messages as UIMessage[];

  // Resolve BEFORE any streaming starts — a bad/missing key or unknown
  // model slug surfaces as a clean JSON error, not a broken half-open
  // stream.
  const { model, providerLabel, modelId } = byokModelId
    ? await resolveByokModel(byokModelId, userId)
    : resolveGatewayModel(requestedModel);

  const chatId = typeof id === 'string' && id ? id : crypto.randomUUID();

  // Persist the user's turn to the row BEFORE streaming, not only in
  // onFinish — so if the model call itself fails outright (network,
  // bad key, upstream outage) the user's own message is never silently
  // lost. onFinish below still overwrites `events` with the complete
  // exchange (including the assistant's reply) once the turn succeeds.
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
    await prisma.eveChatSession
      .update({ where: { id: chatId, userId }, data: { events: uiMessages as any } })
      .catch(err => console.error('[direct chat] pre-stream save failed', chatId, err));
  }

  // Minimal structural ctx — enough for the 8 reused tool-impls. See
  // ToolExecCtx: only `session.id` / `session.auth.current.principalId`
  // are read by the tools reused here (make_it_real/doc_compose for
  // saving docs under the right user+chat; the sub-generation tools read
  // `byokModel` so THEY also honor the resolved model instead of quietly
  // falling back to Gateway).
  const execCtx: ToolExecCtx = {
    session: { id: chatId, auth: { current: { principalId: userId } } },
    byokModel: model,
    // browser_use is intentionally not offered in this path, so getSandbox
    // is never actually called — still provided to satisfy the type.
    async getSandbox() {
      throw new Error('Sandbox tools are not available in direct-model chats yet.');
    },
  };

  const result = streamText({
    model,
    system: SYSTEM_PROMPT,
    stopWhen: stepCountIs(120), // generous ceiling so a long agentic turn is bounded by the 1800s time budget, not an arbitrary low step count
    messages: await convertToModelMessages(uiMessages),
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
    reasoning: resolvedReasoningEffort,
    onError({ error }) {
      console.error('[direct chat] streamText error', chatId, providerLabel, modelId, error);
    },
    tools: {
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
    },
  });

  return result.toUIMessageStreamResponse({
    originalMessages: uiMessages,
    generateMessageId: () => crypto.randomUUID(),
    sendReasoning: true,
    onError(error) {
      // Default behavior swallows the real error into a generic "An error
      // occurred." with nothing else — confirmed cause of "tool calls fail
      // and the AI doesn't respond, no error even shown". Log the full
      // error server-side and surface a real, readable message to the
      // client instead.
      console.error('[direct chat] turn error', chatId, providerLabel, modelId, error);
      if (error instanceof Error) return error.message;
      if (typeof error === 'string') return error;
      return 'Something went wrong generating a response. Please try again.';
    },
    async onFinish({ messages: finalMessages }) {
      await prisma.eveChatSession
        .update({ where: { id: chatId, userId }, data: { events: finalMessages as any } })
        .catch(err => console.error('[direct chat] final save failed', chatId, err));
    },
    headers: {
      'x-direct-chat-session-id': chatId,
      'x-direct-chat-provider': providerLabel,
      'x-direct-chat-model': modelId,
    },
  });
});
