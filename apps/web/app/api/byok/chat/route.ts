/**
 * BYOK-direct chat turn — the ONLY path for a chat where the user picked
 * one of their own saved BYOK models in the model selector.
 *
 * Deliberately bypasses eve's session runtime entirely (no
 * /eve/v1/session call, no eve model, nothing). Why: eve's own `model:`
 * (agent.ts) is fixed once at deploy time and is always the FIRST model
 * to run on every turn — even turns that only ever intend to delegate to
 * a BYOK model via the `run_model` tool. That first eve-root call is a
 * real Vercel AI Gateway inference, which fails outright when the
 * Gateway account has no credit balance (confirmed in testing: 402
 * GatewayInternalServerError), and more fundamentally, users adding BYOK
 * expect zero Gateway involvement, period — not "one cheap Gateway call,
 * then your own key". The only way to guarantee that is to never hand a
 * BYOK turn to eve at all. Picking a BYOK model in the selector now
 * routes the whole chat here instead (see chat-interface.tsx's isByok
 * branch) rather than merely passing byokModelId as a clientContext hint
 * for eve's root model to read and act on.
 *
 * Standard AI SDK v5+ shape throughout (pairs with @ai-sdk/react's
 * useChat + DefaultChatTransport): client posts `{ id, messages, byokModelId }`
 * where `messages` is the full UIMessage[] history (DefaultChatTransport's
 * default request body), we convert to ModelMessage[] for the model call,
 * and persist the full UIMessage[] (including the new assistant message,
 * tool parts and all) via toUIMessageStreamResponse's onFinish.
 *
 * Tool parity: same 8 of run_model.ts's 9 tools that don't require a real
 * eve-provisioned sandbox (browser_use is the one exception — it needs
 * ctx.getSandbox(), which only exists inside an authored eve runtime
 * execution; out of scope here, fast-follow if needed). The other 5
 * (task_analysis, code_artifact, python_coding, make_it_real, doc_compose)
 * do their own internal sub-generation call — patched (see gateway.ts's
 * `model()` override + ToolExecCtx.byokModel) so THOSE calls also use the
 * resolved BYOK model instead of silently falling back to Gateway.
 */
import { NextRequest } from 'next/server';
import { streamText, tool, stepCountIs, convertToModelMessages, type UIMessage } from 'ai';
import { getUserSessionFromRequest } from '@entry/auth';
import { prisma } from '@entry/db';
import { withApiErrorHandling } from '@/lib/api-error';
import { resolveByokModel } from '@/lib/byok/resolve-model';
import type { ToolExecCtx } from '@entry/agent/tool-impls/types';

import { choose } from '@entry/agent/tool-impls/choose';
import { webCrawl } from '@entry/agent/tool-impls/web_crawl';
import { webSearch } from '@entry/agent/tool-impls/web_search';
import { taskAnalysis } from '@entry/agent/tool-impls/task_analysis';
import { codeArtifact } from '@entry/agent/tool-impls/code_artifact';
import { makeItReal } from '@entry/agent/tool-impls/make_it_real';
import { docCompose } from '@entry/agent/tool-impls/doc_compose';
import { pythonCoding } from '@entry/agent/tool-impls/python_coding';

export const POST = withApiErrorHandling(async (req: NextRequest) => {
  const { session } = await getUserSessionFromRequest(req);
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;

  const body = await req.json().catch(() => ({}));
  const { id, messages, byokModelId } = body ?? {};
  if (!byokModelId || typeof byokModelId !== 'string') {
    return Response.json({ error: 'byokModelId is required' }, { status: 400 });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'messages is required' }, { status: 400 });
  }
  const uiMessages = messages as UIMessage[];

  // Resolve BEFORE any streaming starts — a bad/missing key surfaces as a
  // clean JSON error, not a broken half-open stream.
  const { model, providerLabel, modelId } = await resolveByokModel(byokModelId, userId);

  const chatId = typeof id === 'string' && id ? id : crypto.randomUUID();
  const existing = await prisma.eveChatSession.findFirst({ where: { id: chatId, userId } });
  if (!existing) {
    const firstUserTextPart = uiMessages.find(m => m.role === 'user')?.parts?.find((p: any) => p.type === 'text') as { text?: string } | undefined;
    const firstUserText = firstUserTextPart?.text ?? '';
    await prisma.eveChatSession.create({
      data: {
        id: chatId,
        userId,
        byokModelId,
        title: firstUserText.slice(0, 80) || null,
      },
    });
  }

  // Minimal structural ctx — enough for the 8 reused tool-impls. See
  // ToolExecCtx: only `session.id` / `session.auth.current.principalId`
  // are read by the tools reused here (make_it_real/doc_compose for
  // saving docs under the right user+chat; none of the other 6 read ctx
  // at all beyond the byokModel stamp below).
  const execCtx: ToolExecCtx = {
    session: { id: chatId, auth: { current: { principalId: userId } } },
    byokModel: model,
    // browser_use is intentionally not offered in this path, so getSandbox
    // is never actually called — still provided to satisfy the type.
    async getSandbox() {
      throw new Error('Sandbox tools are not available in BYOK-direct chats yet.');
    },
  };

  const result = streamText({
    model,
    stopWhen: stepCountIs(12),
    messages: await convertToModelMessages(uiMessages),
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
    async onFinish({ messages: finalMessages }) {
      await prisma.eveChatSession.update({
        where: { id: chatId, userId },
        data: { events: finalMessages as any },
      }).catch(() => {});
    },
    headers: {
      'x-byok-session-id': chatId,
      'x-byok-provider': providerLabel,
      'x-byok-model': modelId,
    },
  });
});
