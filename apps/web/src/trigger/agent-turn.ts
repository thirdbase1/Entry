/**
 * Long-running chat turn task (2026-07-21) -- the "run past Vercel's 300s
 * ceiling" counterpart to /api/direct/chat/route.ts.
 *
 * ARCHITECTURE:
 * - `agentTurnTask` ("agent-chat-turn"): does the actual work -- same
 *   tool set, model resolution, persona, and streamText config as the
 *   synchronous route, wrapped with `withAgentTimeout` (10 min default
 *   per tool call, per-call override up to 1h, see
 *   apps/agent/agent/lib/tool-impls/with-agent-timeout.ts -- built
 *   2026-07-20, already existed, now actually wired in). Persists
 *   incrementally after every step (same protection route.ts's own
 *   incremental version capture already has) so a hard kill never loses
 *   more than the in-flight step. maxDuration 3600 (1h) -- Trigger.dev's
 *   own infra, not a Vercel function, so this is genuinely not capped at
 *   300s/800s the way the Vercel route is.
 * - `agentTurnOrchestratorTask` ("agent-chat-turn-orchestrator"): the
 *   auto-continue wrapper. Calls the worker via `triggerAndWait`; if the
 *   worker's run didn't finish naturally (crashed, got cut off by its
 *   own 3600s ceiling, or the model stopped mid-plan), re-triggers a
 *   fresh worker run with a synthetic "continue" user message appended
 *   to whatever was already persisted -- up to MAX_HOPS times, so one
 *   genuinely huge task can span multiple chained 1h runs instead of
 *   dying at the first ceiling, while still having a hard, sane overall
 *   limit instead of looping forever.
 *
 * DELIBERATE SCOPE NOTE: the streamText config here duplicates (rather
 * than imports) route.ts's tool wiring/persona/compaction -- see that
 * route's own comments for why (heavily-hardened live file, copying
 * deliberately rather than a blind shared-module refactor). Follow-up:
 * extract a shared module once this has real production mileage.
 */
import { task, metadata } from '@trigger.dev/sdk/v3';
import {
  streamText,
  tool,
  stepCountIs,
  convertToModelMessages,
  smoothStream,
  readUIMessageStream,
  InvalidToolInputError,
  type UIMessage,
} from 'ai';
import { prisma } from '@entry/db';
import { logError } from '@entry/db/error-log';
import { captureVersionFromSandboxDiff } from '@entry/db/chat-versioning';
import { recordUsageEvent } from '@entry/db/usage-metering';
import { resolveByokModel } from '@/lib/byok/resolve-model';
import { resolveGatewayModel } from '@/lib/direct-chat/resolve-gateway-model';
import { getSandboxForChat } from '@/lib/direct-chat/sandbox';
import { sanitizeDanglingToolCalls } from '@/lib/direct-chat/sanitize-messages';
import { fillEmptyAssistantReply } from '@/lib/direct-chat/fill-empty-refusal';
import { stripReasoningParts } from '@/lib/direct-chat/strip-reasoning-parts';
import { compactMessagesIfNeeded } from '@/lib/direct-chat/compact-messages';
import { applyToolCacheBreakpoint, buildCachedSystemMessage, applyConversationCacheControl } from '@/lib/direct-chat/prompt-cache';
import { buildPersonaInstructions } from '@entry/agent/lib/persona';
import { resolveModelIdForProvider } from '@entry/agent/lib/model-catalog';
import type { ToolExecCtx } from '@entry/agent/tool-impls/types';
import { getWorkingMemory } from '@entry/agent/lib/working-memory';
import { withAgentTimeout, DEFAULT_TOOL_TIMEOUT_MS } from '@entry/agent/tool-impls/with-agent-timeout';

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

const FLAKY_PROVIDERS_DROP_TOOLS_AFTER_STEP_1 = new Set(['Woino']);

// Sub-agent delegation runs a NESTED full agent loop of its own -- the
// plain 10-minute default is too tight for it specifically. 30 min is
// generous without being unbounded (still capped at 1h via the wrapper's
// own MAX_TIMEOUT_SECONDS if a call ever tried to override it higher).
const AGENT_TOOL_TIMEOUT_MS = 30 * 60 * 1000;

// Soft, in-process deadline: once we're this far into the task's own
// 3600s maxDuration, stop handing the model tools on its NEXT step so it
// wraps up in plain text instead of starting new work doomed to be cut
// off by the hard external kill. Leaves 5 real minutes of buffer for the
// current step + our own persistence/streaming teardown to finish
// cleanly before Trigger.dev's own ceiling would hit.
const SOFT_DEADLINE_MS = 55 * 60 * 1000;

export interface AgentTurnPayload {
  chatId: string;
  userId: string;
  /** Full UIMessage[] history, exactly what the client would post to /api/direct/chat. */
  messages: UIMessage[];
  byokModelId?: string;
  requestedModel?: string;
  disabledTools?: string[];
}

export interface AgentTurnResult {
  chatId: string;
  finishReason: string | undefined;
  rawFinishReason: string | undefined;
  /** True only when the model actually stopped on its own with no more
   * pending work -- false for anything cut off by our own step cap or
   * soft deadline, which is the orchestrator's signal to auto-continue. */
  finishedNaturally: boolean;
  stepCount: number;
}

export const agentTurnTask = task({
  id: 'agent-chat-turn',
  // Well beyond Vercel's ceiling -- the entire point of this task.
  maxDuration: 3600,
  run: async (payload: AgentTurnPayload): Promise<AgentTurnResult> => {
    const startedAt = Date.now();
    const { chatId, userId, byokModelId, requestedModel, disabledTools } = payload;
    const uiMessages = sanitizeDanglingToolCalls(payload.messages);

    const userWorkingMemoryPromise = getWorkingMemory(userId);

    const resolved = byokModelId
      ? await resolveByokModel(byokModelId, userId)
      : requestedModel
        ? resolveGatewayModel(requestedModel)
        : resolveGatewayModel(await resolveModelIdForProvider('anthropic'));
    const { model, providerLabel, modelId } = resolved as any;
    const isThirdPartyResponsesRelay = 'isThirdPartyResponsesRelay' in (resolved as any) && (resolved as any).isThirdPartyResponsesRelay;
    const isThirdPartyAnthropicRelay = 'isThirdPartyAnthropicRelay' in (resolved as any) && (resolved as any).isThirdPartyAnthropicRelay;

    let sandboxPromise: ReturnType<typeof getSandboxForChat> | undefined;
    const execCtx: ToolExecCtx = {
      session: { id: chatId, auth: { current: { principalId: userId } } },
      byokModel: model,
      async getSandbox() {
        if (!sandboxPromise) sandboxPromise = getSandboxForChat(chatId);
        return sandboxPromise;
      },
    } as any;

    const messagesForModel = (isThirdPartyResponsesRelay || isThirdPartyAnthropicRelay) ? stripReasoningParts(uiMessages) : uiMessages;
    const compactionResult = await compactMessagesIfNeeded(messagesForModel, model, modelId);
    const { messages: compactedMessages, summaryText } = compactionResult as any;
    const convertedMessages = applyConversationCacheControl(await convertToModelMessages(compactedMessages));

    const userWorkingMemory = await userWorkingMemoryPromise;

    const disabledToolSet = new Set(Array.isArray(disabledTools) ? disabledTools.filter((t): t is string => typeof t === 'string') : []);

    // Every tool wrapped with the 10-min-default timeout ceiling
    // (2026-07-20's with-agent-timeout.ts, now actually wired) -- ALL 22
    // tools the live route registers, none skipped, `agent` given its
    // own longer 30-min ceiling since it runs a nested loop.
    const rawTools = {
      choose: withAgentTimeout('choose', choose),
      web_crawl: withAgentTimeout('web_crawl', webCrawl),
      web_search: withAgentTimeout('web_search', webSearch),
      task_analysis: withAgentTimeout('task_analysis', taskAnalysis),
      code_artifact: withAgentTimeout('code_artifact', codeArtifact),
      python_coding: withAgentTimeout('python_coding', pythonCoding),
      write_file: withAgentTimeout('write_file', writeFileTool),
      edit_file: withAgentTimeout('edit_file', editFileTool),
      read_file: withAgentTimeout('read_file', readFileTool),
      bash: withAgentTimeout('bash', bash),
      browser_use: withAgentTimeout('browser_use', browserUse),
      browser_stop: withAgentTimeout('browser_stop', browserStop),
      list_files: withAgentTimeout('list_files', listFilesTool),
      save_credential: withAgentTimeout('save_credential', saveCredentialTool),
      list_credentials: withAgentTimeout('list_credentials', listCredentialsTool),
      inject_credential: withAgentTimeout('inject_credential', injectCredentialTool),
      create_skill: withAgentTimeout('create_skill', createSkillTool),
      list_skills: withAgentTimeout('list_skills', listSkillsTool),
      recall_skill: withAgentTimeout('recall_skill', recallSkillTool),
      get_preview_url: withAgentTimeout('get_preview_url', getPreviewUrlTool),
      restart_sandbox: withAgentTimeout('restart_sandbox', restartSandboxTool),
      agent: withAgentTimeout('agent', agentDelegate, AGENT_TOOL_TIMEOUT_MS),
      remember_about_user: withAgentTimeout('remember_about_user', rememberAboutUserTool),
    } as const;

    const allTools = {
      choose: tool({ description: rawTools.choose.description, inputSchema: rawTools.choose.inputSchema, execute: rawTools.choose.execute }),
      web_crawl: tool({ description: rawTools.web_crawl.description, inputSchema: rawTools.web_crawl.inputSchema, execute: rawTools.web_crawl.execute }),
      web_search: tool({ description: rawTools.web_search.description, inputSchema: rawTools.web_search.inputSchema, execute: rawTools.web_search.execute }),
      task_analysis: tool({ description: rawTools.task_analysis.description, inputSchema: rawTools.task_analysis.inputSchema, execute: (input: any) => rawTools.task_analysis.execute(input, execCtx) }),
      code_artifact: tool({ description: rawTools.code_artifact.description, inputSchema: rawTools.code_artifact.inputSchema, execute: (input: any) => rawTools.code_artifact.execute(input, execCtx) }),
      python_coding: tool({ description: rawTools.python_coding.description, inputSchema: rawTools.python_coding.inputSchema, execute: (input: any) => rawTools.python_coding.execute(input, execCtx) }),
      write_file: tool({ description: rawTools.write_file.description, inputSchema: rawTools.write_file.inputSchema, execute: (input: any) => rawTools.write_file.execute(input, execCtx) }),
      edit_file: tool({ description: rawTools.edit_file.description, inputSchema: rawTools.edit_file.inputSchema, execute: (input: any) => rawTools.edit_file.execute(input, execCtx) }),
      read_file: tool({ description: rawTools.read_file.description, inputSchema: rawTools.read_file.inputSchema, execute: (input: any) => rawTools.read_file.execute(input, execCtx) }),
      bash: tool({ description: rawTools.bash.description, inputSchema: rawTools.bash.inputSchema, execute: (input: any) => rawTools.bash.execute(input, execCtx) }),
      browser_use: tool({ description: rawTools.browser_use.description, inputSchema: rawTools.browser_use.inputSchema, execute: (input: any) => rawTools.browser_use.execute(input, execCtx) }),
      browser_stop: tool({ description: rawTools.browser_stop.description, inputSchema: rawTools.browser_stop.inputSchema, execute: (input: any) => rawTools.browser_stop.execute(input, execCtx) }),
      list_files: tool({ description: rawTools.list_files.description, inputSchema: rawTools.list_files.inputSchema, execute: (input: any) => rawTools.list_files.execute(input, execCtx) }),
      save_credential: tool({ description: rawTools.save_credential.description, inputSchema: rawTools.save_credential.inputSchema, execute: (input: any) => rawTools.save_credential.execute(input, execCtx) }),
      list_credentials: tool({ description: rawTools.list_credentials.description, inputSchema: rawTools.list_credentials.inputSchema, execute: (input: any) => rawTools.list_credentials.execute(input ?? {}, execCtx) }),
      inject_credential: tool({ description: rawTools.inject_credential.description, inputSchema: rawTools.inject_credential.inputSchema, execute: (input: any) => rawTools.inject_credential.execute(input, execCtx) }),
      create_skill: tool({ description: rawTools.create_skill.description, inputSchema: rawTools.create_skill.inputSchema, execute: (input: any) => rawTools.create_skill.execute(input, execCtx) }),
      list_skills: tool({ description: rawTools.list_skills.description, inputSchema: rawTools.list_skills.inputSchema, execute: (input: any) => rawTools.list_skills.execute(input ?? {}, execCtx) }),
      recall_skill: tool({ description: rawTools.recall_skill.description, inputSchema: rawTools.recall_skill.inputSchema, execute: (input: any) => rawTools.recall_skill.execute(input, execCtx) }),
      get_preview_url: tool({ description: rawTools.get_preview_url.description, inputSchema: rawTools.get_preview_url.inputSchema, execute: (input: any) => rawTools.get_preview_url.execute(input ?? {}, execCtx) }),
      restart_sandbox: tool({ description: rawTools.restart_sandbox.description, inputSchema: rawTools.restart_sandbox.inputSchema, execute: (input: any) => rawTools.restart_sandbox.execute(input, execCtx) }),
      agent: tool({ description: rawTools.agent.description, inputSchema: rawTools.agent.inputSchema, execute: (input: any) => rawTools.agent.execute(input, execCtx) }),
      remember_about_user: tool({ description: rawTools.remember_about_user.description, inputSchema: rawTools.remember_about_user.inputSchema, execute: (input: any) => rawTools.remember_about_user.execute(input, execCtx) }),
    } as const;
    const activeTools = Object.fromEntries(Object.entries(allTools).filter(([name]) => !disabledToolSet.has(name))) as typeof allTools;

    const SYSTEM_PROMPT = buildPersonaInstructions({
      includeAgentDelegation: true,
      workingMemory: userWorkingMemory,
      availableTools: Object.keys(activeTools),
    } as any);
    const systemMessage = buildCachedSystemMessage(SYSTEM_PROMPT);
    const instructions = summaryText ? [systemMessage, { role: 'system' as const, content: summaryText }] : systemMessage;

    let lastFinishReason: string | undefined;
    let lastRawFinishReason: string | undefined;
    let stepCount = 0;
    let softDeadlineHit = false;

    const result = streamText({
      model,
      stopWhen: stepCountIs(120),
      instructions: instructions as any,
      messages: convertedMessages,
      prepareStep({ stepNumber }) {
        if (stepNumber > 0 && FLAKY_PROVIDERS_DROP_TOOLS_AFTER_STEP_1.has(providerLabel)) {
          return { activeTools: [] };
        }
        if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
          softDeadlineHit = true;
          return { activeTools: [] };
        }
        return {};
      },
      repairToolCall: async ({ toolCall, tools, error }) => {
        const realName = Object.keys(tools).find(name => name.toLowerCase() === toolCall.toolName.toLowerCase());
        if (realName !== undefined && realName !== toolCall.toolName) {
          return { ...toolCall, toolName: realName };
        }
        const PATH_ALIASING_TOOLS = new Set(['write_file', 'read_file', 'append_file', 'edit_file']);
        const PATH_ALIASES = ['file_path', 'filePath', 'filename', 'fileName', 'file'];
        if (InvalidToolInputError.isInstance(error) && PATH_ALIASING_TOOLS.has(toolCall.toolName)) {
          try {
            const parsed = JSON.parse((error as any).toolInput) as Record<string, unknown>;
            if (typeof parsed.path !== 'string') {
              const aliasKey = PATH_ALIASES.find(key => typeof parsed[key] === 'string');
              if (aliasKey !== undefined) {
                const { [aliasKey]: aliasValue, ...rest } = parsed;
                return { ...toolCall, input: JSON.stringify({ ...rest, path: aliasValue }) };
              }
            }
          } catch {
            // not parseable -- no repair
          }
        }
        return null;
      },
      onError({ error }) {
        console.error('[agent-turn task] streamText error', chatId, providerLabel, modelId, error);
        logError({ source: 'agent-turn-task-streamtext', error, userId, chatId, context: { providerLabel, modelId } });
      },
      async onStepFinish(step) {
        stepCount += 1;
        const { stepNumber, finishReason, rawFinishReason, toolCalls, toolResults, usage, text, warnings, content } = step as any;
        lastFinishReason = finishReason;
        lastRawFinishReason = rawFinishReason;
        const toolErrors = content
          .filter((part: any) => part.type === 'tool-error')
          .map((part: any) => ({ tool: part.toolName, error: part.error instanceof Error ? part.error.message : String(part.error) }));
        console.log('[agent-turn task] step finished', {
          chatId, providerLabel, modelId, stepNumber, finishReason, rawFinishReason,
          toolCallCount: toolCalls.length, toolNames: toolCalls.map((c: any) => c.toolName),
          toolResultCount: toolResults.length, toolErrors, textLength: text.length, usage, warnings,
        });

        if (usage && (usage.inputTokens != null || usage.outputTokens != null)) {
          await recordUsageEvent({
            userId, chatId, source: 'direct-chat', model: modelId,
            provider: byokModelId ? `byok:${providerLabel}` : 'gateway',
            usage: {
              inputTokens: usage.inputTokenDetails?.noCacheTokens ?? usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              cacheCreationTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
              cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
            },
            finishReason, success: toolErrors.length === 0,
          }).catch(() => {});
        }

        await metadata.stream('step', (async function* () {
          yield { stepNumber, finishReason, toolNames: toolCalls.map((c: any) => c.toolName), textLength: text.length };
        })()).catch(() => {});

        if (sandboxPromise && toolCalls.length > 0) {
          const sandbox = await sandboxPromise;
          await captureVersionFromSandboxDiff(chatId, sandbox, { skipCard: true }).catch((err: unknown) => {
            console.error('[agent-turn task] incremental step version capture failed', chatId, err);
          });
        }

        // Incremental durability for the CHAT HISTORY ITSELF (not just
        // sandbox files) -- persist what we have after every step, same
        // motivation as route.ts's incremental version capture: a hard
        // kill mid-turn should never lose more than the in-flight step.
        try {
          const chunkStreamSoFar = (result as any).toUIMessageStream({
            originalMessages: uiMessages,
            generateMessageId: () => crypto.randomUUID(),
            sendReasoning: true,
          });
          let partial: UIMessage | undefined;
          for await (const msg of readUIMessageStream({ stream: chunkStreamSoFar })) {
            partial = msg;
          }
          if (partial) {
            await prisma.eveChatSession.update({
              where: { id: chatId, userId },
              data: { events: [...uiMessages, partial] as any },
            }).catch(() => {});
          }
        } catch {
          // Best-effort -- the final save below is the source of truth.
        }
      },
      tools: applyToolCacheBreakpoint(activeTools as any),
      experimental_transform: smoothStream({ chunking: 'word', delayInMs: 0 }),
    });

    await metadata.stream('text', result.textStream).catch(() => {});

    const chunkStream = (result as any).toUIMessageStream({
      originalMessages: uiMessages,
      generateMessageId: () => crypto.randomUUID(),
      sendReasoning: true,
    });
    let finalNewMessage: UIMessage | undefined;
    for await (const msg of readUIMessageStream({ stream: chunkStream })) {
      finalNewMessage = msg;
    }

    const finalMessages = finalNewMessage
      ? fillEmptyAssistantReply(sanitizeDanglingToolCalls([...uiMessages, finalNewMessage]), lastFinishReason, lastRawFinishReason)
      : uiMessages;

    await prisma.eveChatSession.update({
      where: { id: chatId, userId },
      data: { events: finalMessages as any },
    }).catch((err: unknown) => {
      console.error('[agent-turn task] final save failed', chatId, err);
      logError({ source: 'agent-turn-task-final-save', error: err, userId, chatId });
    });

    if (sandboxPromise) {
      const sandbox = await sandboxPromise;
      await captureVersionFromSandboxDiff(chatId, sandbox, { skipCard: false }).catch(() => {});
    }

    // "Natural" completion = the model stopped on its own (finishReason
    // 'stop'/'length'/'content-filter', no more tool calls pending) AND
    // we never had to force tools off due to the soft deadline, AND we
    // didn't hit the outer 120-step safety cap. Anything else is exactly
    // what the orchestrator should auto-continue from.
    const finishedNaturally = !softDeadlineHit && stepCount < 120 && lastFinishReason !== 'tool-calls';

    return { chatId, finishReason: lastFinishReason, rawFinishReason: lastRawFinishReason, finishedNaturally, stepCount };
  },
});
