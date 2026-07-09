/**
 * Replaces the old subagents/{claude,gpt,gemini} delegation entirely.
 *
 * Why a tool and not subagents: eve pins a declared subagent's model at
 * BUILD time (agent.ts's `model:` is resolved once, at deploy). That's
 * fine for a small fixed set of providers known ahead of time, but it
 * cannot represent "any model the user picks in the selector" or BYOK
 * (arbitrary provider/baseURL/key, added by a user at runtime, unknown at
 * build time). A tool's `execute(input, ctx)` runs authored code per
 * request, so it CAN construct any model client on demand from runtime
 * data. This is the one and only place model selection happens now.
 *
 * "Nothing must be gated" for BYOK: this tool hands the selected/BYOK
 * model the EXACT SAME 9 tools root has (imported from the same
 * lib/tool-impls modules root's own tools/*.ts wrap — no capability
 * subset, no duplicated logic), and runs a real multi-step tool loop
 * (stopWhen: stepCountIs), so a BYOK model can call web_search,
 * browser_use, python_coding, doc_compose, etc. just like the root agent
 * can. It gets the same sandbox too, via the same ctx.getSandbox().
 */
import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { generateText, tool, stepCountIs, type LanguageModel } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { prisma, decryptApiKey } from '@entry/db';

import { choose } from '../lib/tool-impls/choose.js';
import { webCrawl } from '../lib/tool-impls/web_crawl.js';
import { webSearch } from '../lib/tool-impls/web_search.js';
import { browserUse } from '../lib/tool-impls/browser_use.js';
import { taskAnalysis } from '../lib/tool-impls/task_analysis.js';
import { codeArtifact } from '../lib/tool-impls/code_artifact.js';
import { makeItReal } from '../lib/tool-impls/make_it_real.js';
import { docCompose } from '../lib/tool-impls/doc_compose.js';
import { pythonCoding } from '../lib/tool-impls/python_coding.js';
import type { ToolExecCtx } from '../lib/tool-impls/types.js';

const inputSchema = z.object({
  // Exact AI Gateway catalog slug, e.g. "anthropic/claude-opus-4.8" or
  // "openai/gpt-5.2" — required unless byokModelId is given.
  modelSlug: z.string().optional().describe('AI Gateway model slug to use, e.g. "anthropic/claude-opus-4.8". Omit only when byokModelId is set.'),
  // Id of a saved UserModelProviderModel row (BYOK) — takes priority over modelSlug when set.
  byokModelId: z.string().optional().describe("The user's saved BYOK model id (from their provider connections) to use instead of a Gateway model."),
  task: z.string().describe("The user's full request/message to hand to the selected model, verbatim, plus any relevant context."),
  parameters: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    })
    .optional()
    .describe('Optional generation parameters. Omit to use provider defaults.'),
});

async function resolveModel(input: z.infer<typeof inputSchema>, ctx: ToolExecCtx): Promise<LanguageModel> {
  if (input.byokModelId) {
    const userId = ctx.session.auth.current?.principalId;
    if (!userId) throw new Error('No authenticated user on this session — cannot look up a BYOK model.');

    // Ownership check happens through the provider relation's userId — a
    // model id alone is never sufficient authorization.
    const modelRow = await prisma.userModelProviderModel.findFirst({
      where: { id: input.byokModelId, isEnabled: true, provider: { userId } },
      include: { provider: true },
    });
    if (!modelRow) {
      throw new Error('BYOK model not found, disabled, or not owned by the current user.');
    }

    const { provider } = modelRow;
    const apiKey = provider.encryptedApiKey ? decryptApiKey(provider.encryptedApiKey) : undefined;

    switch (provider.compatibility) {
      case 'ANTHROPIC':
        return createAnthropic({ baseURL: provider.baseUrl, apiKey })(modelRow.modelId);
      case 'GOOGLE':
        return createGoogleGenerativeAI({ baseURL: provider.baseUrl, apiKey })(modelRow.modelId);
      case 'OPENAI':
      default:
        return createOpenAICompatible({ name: provider.label, baseURL: provider.baseUrl, apiKey })(modelRow.modelId);
    }
  }

  if (!input.modelSlug) {
    throw new Error('One of modelSlug or byokModelId is required.');
  }
  return gateway(input.modelSlug);
}

export default defineTool({
  description:
    'Hand the current turn to a SPECIFIC model the user explicitly requested (from the model ' +
    'selector, or a saved BYOK provider) instead of answering yourself. Call this whenever the ' +
    "turn's context contains a requestedModel/byokModelId — see <model_routing> in your " +
    'instructions for the exact trigger rule. Pass the full user task; this tool runs the selected ' +
    'model with the SAME tools you have (web search, browser, python, docs, etc.) and returns its ' +
    'final answer.',
  inputSchema,
  async execute(input, ctx) {
    const model = await resolveModel(input, ctx as unknown as ToolExecCtx);
    const execCtx = ctx as unknown as ToolExecCtx;

    const { text, steps } = await generateText({
      model,
      temperature: input.parameters?.temperature,
      maxOutputTokens: input.parameters?.maxOutputTokens,
      stopWhen: stepCountIs(12),
      messages: [{ role: 'user', content: input.task }],
      tools: {
        choose: tool({ description: choose.description, inputSchema: choose.inputSchema, execute: choose.execute }),
        web_crawl: tool({ description: webCrawl.description, inputSchema: webCrawl.inputSchema, execute: webCrawl.execute }),
        web_search: tool({ description: webSearch.description, inputSchema: webSearch.inputSchema, execute: webSearch.execute }),
        browser_use: tool({
          description: browserUse.description,
          inputSchema: browserUse.inputSchema,
          execute: (toolInput: { task: string }) => browserUse.execute(toolInput, execCtx),
        }),
        task_analysis: tool({ description: taskAnalysis.description, inputSchema: taskAnalysis.inputSchema, execute: taskAnalysis.execute }),
        code_artifact: tool({ description: codeArtifact.description, inputSchema: codeArtifact.inputSchema, execute: codeArtifact.execute }),
        make_it_real: tool({
          description: makeItReal.description,
          inputSchema: makeItReal.inputSchema,
          execute: (toolInput: { instructions?: string; markdown: string }) => makeItReal.execute(toolInput, execCtx),
        }),
        doc_compose: tool({
          description: docCompose.description,
          inputSchema: docCompose.inputSchema,
          execute: (toolInput: { title: string; userPrompt: string }) => docCompose.execute(toolInput, execCtx),
        }),
        python_coding: tool({ description: pythonCoding.description, inputSchema: pythonCoding.inputSchema, execute: pythonCoding.execute }),
      },
    });

    return { answer: text, stepsUsed: steps.length };
  },
});
