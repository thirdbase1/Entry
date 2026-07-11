import { generateText, tool, stepCountIs } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { z } from 'zod';
import { resolveModelIdForProvider } from '../model-catalog.js';
import { webSearch } from './web_search.js';
import { webCrawl } from './web_crawl.js';
import { safeExecute } from './safe-execute.js';
import type { ToolExecCtx } from './types.js';

/**
 * Real, dynamic sub-agent delegation — distinct from the deprecated
 * `run_model` (see agent/instructions.ts's big comment for that history).
 * `run_model` used to relay the ENTIRE top-level turn to another model
 * (whole-conversation routing), which caused three real bugs: no
 * streaming, no reasoning passthrough, and unreliable self-identity when
 * the root silently handed off. This tool is architecturally different —
 * it delegates a bounded SUBTASK mid-turn and returns the result as a
 * normal tool result, same shape as web_search/browser_use. The root
 * model stays itself, composes the final reply itself, and simply reads
 * this tool's output like any other tool call — none of run_model's three
 * failure modes apply here, because nothing is relayed to the user
 * directly.
 *
 * This is also what actually implements the landing page's "multi-agent
 * collaboration" pitch ("Claude for plans, Gemini for deep research, GPT
 * for rewriting feedback") — that promise had no real tool behind it
 * before this file existed anywhere in the tool list.
 *
 * Registered as `agent/tools/agent.ts` deliberately: per eve's own docs
 * (node_modules/eve/docs/subagents.mdx — "An authored tool at
 * `agent/tools/agent.ts` takes priority over the built-in"), this
 * replaces eve's built-in `agent` tool (fixed `{message, outputSchema?}`
 * shape, always a copy of the root's own model, no per-call model choice)
 * with one that accepts an explicit `provider`/`model` at call time —
 * eve's declared-subagent and built-in mechanisms only support a model
 * fixed at *definition* time, never picked dynamically per call, so this
 * is the correct way to get real runtime provider/model choice, not a
 * workaround.
 */

const AgentDelegateInputSchema = z.object({
  message: z
    .string()
    .min(1)
    .describe(
      'Everything the sub-agent needs to complete this ONE delegated task. It does not see the ' +
        'parent conversation at all — include full context, constraints, and exactly what result is expected back.'
    ),
  provider: z
    .string()
    .optional()
    .describe(
      'AI provider to delegate to, e.g. "anthropic", "google", "openai", "deepseek", "xai", "moonshotai", "zai". ' +
        'When given without `model`, automatically picks that provider\'s strongest currently-available model from the live Gateway catalog. ' +
        'Pick deliberately for the task: e.g. "google" for deep research / large-context reading, "anthropic" for careful planning or precise reasoning, ' +
        '"openai" for rewriting tone/style. Omit both `provider` and `model` to delegate to a copy of yourself (same model as this turn).'
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Exact model to delegate to. Either a full Gateway id ("google/gemini-3-pro-preview") or a bare model name combined with `provider` ' +
        '("gemini-3-pro-preview" alongside provider "google"). Takes priority over the provider\'s auto-picked default when both resolve to a specific model.'
    ),
});

const AgentDelegateResultSchema = z.object({
  result: z.string(),
  modelUsed: z.string(),
  stepsTaken: z.number(),
  note: z.string().optional(),
});

const SUBAGENT_SYSTEM_PROMPT =
  'You are a focused sub-agent completing ONE delegated task for a parent AI agent. You do not see the parent conversation — ' +
  'only the task message you were given. Use web_search/web_crawl if the task needs current information or a specific page\'s content. ' +
  'Answer completely and directly; your entire reply is returned as-is to the parent, which will use it to continue helping its own user.';

export const agentDelegate = {
  description:
    'Delegate a bounded subtask to a sub-agent, optionally on a SPECIFIC provider/model you choose (e.g. hand deep research to a Gemini model, ' +
    'careful planning to a Claude model, or a rewrite/tone pass to a GPT model) — matching a real multi-model workflow instead of doing everything ' +
    'on a single model. The sub-agent has its own fresh context (it does NOT see this conversation — pack everything it needs into `message`) and ' +
    'can call web_search/web_crawl itself for research tasks. Returns its final result as plain text. Omit `provider`/`model` to delegate to a copy ' +
    'of yourself instead of a different model.',
  inputSchema: AgentDelegateInputSchema,
  outputSchema: AgentDelegateResultSchema,
  async execute({ message, provider, model }: { message: string; provider?: string; model?: string }, ctx?: ToolExecCtx) {
    let note: string | undefined;
    let modelId: string;

    if (ctx?.byokModel) {
      // BYOK turns never touch the Gateway at any depth (same policy as
      // every other sub-generation tool — task_analysis, doc_compose,
      // make_it_real, python_coding, code_artifact) so the platform never
      // foots a Gateway bill on a turn the user is paying for with their
      // own key. A requested provider/model can't be honored here.
      if (provider || model) {
        note = `Custom provider/model requests aren't available on BYOK turns — ran on your connected model instead of ${[provider, model].filter(Boolean).join('/')}.`;
      }
      const { text, steps } = await generateText({
        model: ctx.byokModel,
        system: SUBAGENT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: message }],
        tools: { web_search: tool(webSearch as any), web_crawl: tool(webCrawl as any) },
        stopWhen: stepCountIs(15),
      });
      return { result: text, modelUsed: 'byok', stepsTaken: steps.length, note };
    }

    if (model && model.includes('/')) {
      modelId = model;
    } else if (model && provider) {
      modelId = `${provider}/${model}`;
    } else if (provider) {
      modelId = await resolveModelIdForProvider(provider);
    } else if (model) {
      throw new Error(
        `"model" ("${model}") was given without "provider" and isn't already a full "provider/model" id. ` +
          `Pass a full id like "anthropic/claude-opus-4.8", or add "provider".`
      );
    } else {
      // No explicit ask -- delegate to a copy of the root's own model
      // family, matching eve's built-in `agent` tool default behavior.
      modelId = await resolveModelIdForProvider('anthropic');
    }

    const { text, steps } = await generateText({
      model: gateway(modelId),
      system: SUBAGENT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
      tools: { web_search: tool(webSearch as any), web_crawl: tool(webCrawl as any) },
      stopWhen: stepCountIs(15),
    });

    return { result: text, modelUsed: modelId, stepsTaken: steps.length, note };
  },
};

agentDelegate.execute = safeExecute('agent', agentDelegate.execute) as typeof agentDelegate.execute;
