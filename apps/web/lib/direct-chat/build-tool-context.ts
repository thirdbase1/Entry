/**
 * Builds the tool set + execCtx + system-prompt instructions for one
 * direct-chat leg. EXTRACTED VERBATIM (2026-08-07) from
 * app/api/direct/chat/route.ts's inline construction, unchanged in
 * substance -- moved here so lib/direct-chat/turn-workflow.ts's per-leg
 * step can call it fresh inside a durable workflow step (a step can't
 * receive live closures/tool objects as arguments across a suspension
 * boundary, so this has to be rebuilt from plain serializable inputs on
 * every leg rather than built once and passed in). See turn-workflow.ts's
 * file comment for the full "why a leg" writeup.
 *
 * Rebuilding this per leg (rather than once per turn, the old behavior)
 * is a deliberate, small, accepted cost -- a couple of already-cheap
 * lookups (chatWorkingMemory, buildPersonaInstructions) -- in exchange
 * for the whole turn surviving a Vercel function boundary. Most turns
 * finish in one leg anyway (see MAX_LEG_DURATION_MS in turn-workflow.ts),
 * so this only actually repeats on the genuinely long-running turns this
 * whole migration exists for.
 */
import { tool, type LanguageModel } from 'ai';
import { getWorkingMemory } from '@entry/agent/lib/working-memory';
import { buildPersonaInstructions } from '@entry/agent/lib/persona';
import { buildCachedSystemMessage } from '@/lib/direct-chat/prompt-cache';
import { getSandboxForChat } from '@/lib/direct-chat/sandbox';
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

export interface BuildToolContextInput {
  chatId: string;
  userId: string;
  model: LanguageModel;
  disabledToolNames: string[];
  // NEW (2026-08-07, turn-workflow migration) -- this leg's own
  // AbortController.signal (see turn-workflow.ts's MAX_LEG_DURATION_MS).
  // Forwarded onto execCtx so nested long-running tool calls -- agent.ts's
  // sub-agent delegation above all, since IT runs its own further
  // generateText()+tool loop -- abort cleanly at the SAME leg boundary
  // instead of being hard-killed mid-call by Vercel's own 300s ceiling
  // with no chance to return a partial/graceful result. Wasn't wired to
  // anything real before this migration (grepped the pre-migration route:
  // execCtx.abortSignal was never set there either, so agent.ts's own
  // abortSignal-forwarding code -- already written, see its ctxTool/
  // withTimeoutSignal usage -- was dead until now); this closes that gap
  // as a strict improvement, not a behavior change for anything that
  // wasn't already reading it.
  abortSignal?: AbortSignal;
}

export async function buildDirectChatToolContext({ chatId, userId, model, disabledToolNames, abortSignal }: BuildToolContextInput) {
  const chatWorkingMemory = await getWorkingMemory(chatId);
  const disabledToolSet = new Set(disabledToolNames);
  let sandboxPromise: ReturnType<typeof getSandboxForChat> | undefined;
  const execCtx: ToolExecCtx = {
    session: { id: chatId, auth: { current: { principalId: userId } } },
    byokModel: model,
    abortSignal,
    async getSandbox() {
      if (!sandboxPromise) sandboxPromise = getSandboxForChat(chatId);
      return sandboxPromise;
    },
  };

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
      execute: (input: { path: string; old_text?: string; new_text?: string; old_str?: string; new_str?: string; replace_all?: boolean }) => editFileTool.execute(input, execCtx),
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
    // ChatWorkingMemory's schema comment and persona.ts's comment. Wired
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
    workingMemory: chatWorkingMemory,
    availableTools: Object.keys(activeTools),
  });
  // Compaction removed (see above) -- instructions is now just the
  // persona system prompt, no async summary branch to fold in anymore.
  const instructions = Promise.resolve(buildCachedSystemMessage(SYSTEM_PROMPT));

  return { execCtx, activeTools, SYSTEM_PROMPT, instructions, getSandboxPromise: () => sandboxPromise };
}
