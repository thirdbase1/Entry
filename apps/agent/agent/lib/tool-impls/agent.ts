import { generateText, tool, stepCountIs, type LanguageModel } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { z } from 'zod';
import { resolveModelIdForProvider, getCatalogMenu } from '../model-catalog.js';
import { resolveUserCustomProviderModel, listUserCustomProviderLabels } from '../custom-model-provider.js';
import { webSearch } from './web_search.js';
import { webCrawl } from './web_crawl.js';
import { bash } from './bash.js';
import { listFilesTool } from './list_files.js';
import { writeFileTool } from './write_file.js';
import { editFileTool } from './edit_file.js';
import { appendFileTool } from './append_file.js';
import { codeArtifact } from './code_artifact.js';
import { pythonCoding } from './python_coding.js';
import { browserUse } from './browser_use.js';
import { browserStop } from './browser_stop.js';
import { safeExecute } from './safe-execute.js';
import { withTransientRetry } from '../transient-provider-error.js';
import { withTimeoutSignal } from './with-timeout-signal.js';
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
 *
 * IMPROVED (2026-07-17, "improve the whole AI process for long term
 * task"): three real gaps for anything that takes more than a handful of
 * steps:
 *
 *   1. A hardcoded `stepCountIs(15)` for every delegated task regardless
 *      of size -- a genuinely large subtask (e.g. "read these 6 pages
 *      and cross-reference them", multi-part research, iterative
 *      drafting) could get cut off mid-work with no way for the caller
 *      to ask for a longer leash. Now callers can pass `maxSteps`
 *      (bounded 1-40) when they know a task is bigger than the default.
 *   2. No way to tell a clean finish from a step-limit cutoff -- both
 *      returned `{ result: text, ... }` identically, so the parent model
 *      had no signal that a "finished" subtask was actually truncated
 *      mid-thought. Now checks the last step's `finishReason`: if the
 *      loop only stopped because the step budget ran out (not because
 *      the model itself decided it was done), `truncated: true` is
 *      returned plus a note telling the parent it can re-delegate a
 *      continuation using this result as context.
 *   3. Zero retry on transient upstream errors (the same "no available
 *      channel"/capacity-style failures browser_use.ts already learned
 *      to retry past) -- a single blip anywhere in a long multi-step
 *      subtask used to fail the ENTIRE delegated task outright. Now
 *      wrapped in the same shared withTransientRetry used by
 *      browser_use.ts.
 */

/**
 * IMPROVED (2026-07-18, "agent can specify provider/model on the tool
 * call, agent sees all the provider and model, do it super simple so
 * selecting doesn't take time"): fetched ONCE at module load (top-level
 * await, same established convention as agent.ts's own
 * `resolveModelIdForProvider('anthropic')` cold-start call) so:
 *   1. `provider` becomes a REAL `z.enum(...)` of whatever providers the
 *      live catalog actually has right now -- an invalid provider is
 *      rejected by schema validation before execute() ever runs, instead
 *      of failing deep inside a real tool call.
 *   2. `model`'s description gets an actual menu of concrete, currently-
 *      valid ids per provider, so the calling model can pick a real one
 *      directly instead of recalling/inventing a slug that may not exist.
 *   3. This also warms model-catalog.ts's shared 5-minute cache, so the
 *      FIRST real delegate call of a cold start (which calls
 *      `resolveModelIdForProvider` internally) no longer pays a cold
 *      catalog fetch -- it's already warm from this module-load call.
 * A cold-start catalog hiccup can't take the tool down: getCatalogMenu()
 * falls back to a small known-good provider list on any fetch failure.
 */
const catalogMenu = await getCatalogMenu();

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
      `EITHER a live AI Gateway provider family -- one of: ${catalogMenu.providers.join(', ')} -- OR the label of one of THIS user's own ` +
        'saved custom/BYOK providers from their settings page (e.g. a personal relay or endpoint they connected themselves, such as ' +
        '"aerolink") -- both are supported the same way, just pass whichever name applies. For a Gateway family given without `model`, ' +
        "automatically picks that provider's strongest currently-available model; for a user's own custom provider given without " +
        "`model`, automatically picks the first model they enabled under it. Pick a Gateway family deliberately for the task: e.g. " +
        '"google" for deep research / large-context reading, "anthropic" for careful planning or precise reasoning, "openai" for ' +
        'rewriting tone/style. Omit both `provider` and `model` to delegate to a copy of yourself (same model as this turn).'
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Exact model to delegate to. For a Gateway `provider`: either a full Gateway id ("google/gemini-3-pro-preview") or a bare model ' +
        'name combined with `provider` ("gemini-3-pro-preview" alongside provider "google") -- takes priority over the auto-picked ' +
        "default when both resolve to a specific model. Real, currently-valid Gateway options per provider (pick one of these directly " +
        `when you want a SPECIFIC model rather than that provider's auto-picked best): ${catalogMenu.menuText}. For a user's own custom ` +
        'provider: the exact model id/slug they registered it under in settings (e.g. "gpt-5.6-sol") -- omit to auto-pick their first ' +
        'enabled model under that provider.'
    ),
  maxSteps: z
    .number()
    .int()
    .min(1)
    .max(40)
    .optional()
    .describe(
      'Step budget for this subtask (default 15). Raise this (up to 40) for a genuinely large/long-running subtask — multi-part research, reading ' +
        'several sources and cross-referencing them, iterative drafting — where 15 steps of tool calls + reasoning realistically will not be enough. ' +
        "Leave it at the default for anything bounded/simple; a bigger budget just means a truncated failure takes longer to surface if it WAS simple."
    ),
});

const AgentDelegateResultSchema = z.object({
  result: z.string(),
  modelUsed: z.string(),
  stepsTaken: z.number(),
  truncated: z.boolean().optional(),
  note: z.string().optional(),
});

const SUBAGENT_SYSTEM_PROMPT =
  'You are a focused sub-agent completing ONE delegated task for a parent AI agent. You do not see the parent conversation — ' +
  'only the task message you were given. Answer completely and directly; your entire reply is returned as-is to the parent, ' +
  'which will use it to continue helping its own user. ' +
  // IMPROVED (2026-07-18, "give sub agent tools too, use best judgement"): previously only had web_search/web_crawl, so any
  // delegated task needing real execution (run this, edit that file, drive a browser) had no way to actually do it -- it could
  // only ever describe what SHOULD happen, not make it happen. Added the tools that fit a bounded, isolated subtask with no
  // broader context of its own; see this file's runDelegatedTask for the full tool set + what was deliberately left out and why.
  'You also have bash, list_files/write_file/edit_file/append_file, code_artifact, python_coding, web_search/web_crawl, and ' +
  'browser_use/browser_stop. IMPORTANT: bash/file/browser tools run in the SAME live sandbox as the parent turn\'s ongoing project ' +
  '-- any file you write or command you run is real and persists, not an isolated scratch copy. If you start a browser_use ' +
  'session, always call browser_stop when you are done with it (or before finishing if you still have one open), so it is not ' +
  'left running/billing after your task ends. ' +
  "If you're running low on remaining steps and won't finish in time, don't trail off mid-thought — stop and clearly summarize what you " +
  "did complete, what's still left, and what the parent should do next (e.g. re-delegate the remainder with your partial result as context).";

function isTruncatedFinish(steps: { finishReason?: string }[], maxSteps: number): boolean {
  if (steps.length < maxSteps) return false;
  const last = steps[steps.length - 1];
  // Only 'stop' means the model itself decided it was done. Anything else
  // on the very last allowed step (still wanting to call a tool, hit a
  // length cap, etc.) means the step budget is what actually ended this,
  // not the model reaching a genuine conclusion.
  return last?.finishReason !== 'stop';
}

/**
 * IMPROVED (2026-07-18, "improve the sub agent tool x3"):
 *
 *   1. TIMEOUT + ABORT WIRING (the real gap): this tool made its own
 *      internal `generateText` call(s) with no timeout and never combined
 *      `ctx.abortSignal` in at all -- every sibling sub-generation tool
 *      (task_analysis, code_artifact, python_coding, bash) already went
 *      through this exact fix via `withTimeoutSignal`, but it was never
 *      applied here even though a multi-step delegated subtask (up to 40
 *      steps, each potentially a slow web_search/web_crawl call) is
 *      arguably the MOST likely tool to actually hang. Concretely this
 *      used to mean: (a) a stuck upstream call rides along silently until
 *      the outer turn's own platform ceiling kills the whole turn with
 *      nothing surfaced, and (b) the user's Stop button did nothing for
 *      an in-flight delegated subtask -- it kept running (and billing
 *      tokens) server-side after the parent turn was cancelled, since
 *      nothing ever told this generateText call to abort.
 *   2. The timeout now SCALES with the requested `maxSteps` budget
 *      instead of one blanket constant -- a caller-requested 40-step deep
 *      research task legitimately needs more wall-clock time than the
 *      15-step default, and a fixed short timeout would have made
 *      `maxSteps` an empty promise for anything long. Capped at 280s to
 *      stay under the same 300s platform ceiling bash.ts's own fix
 *      documents (240s + margin there; kept a little tighter here since
 *      the retry-on-transient-error wrapper below can itself cost a
 *      config extra multi-second delay on top).
 *   3. De-duplicated the BYOK and Gateway branches into one shared
 *      `runDelegatedTask` -- they were two independent copies of the same
 *      generateText+retry+timeout call differing only in which `model` is
 *      passed, which is exactly the "two similar code paths silently
 *      drift apart" bug class this codebase has hit for real before (see
 *      use-streaming-autoscroll.ts's file comment: one chat path got a
 *      streaming fix, the other didn't, for months). Fixing it here means
 *      this timeout wiring -- or any future fix to this call -- can't
 *      silently apply to only one of the two paths again.
 */
const BASE_TIMEOUT_MS = 90_000;
const PER_EXTRA_STEP_MS = 8_000;
const MAX_TIMEOUT_MS = 280_000;
const DEFAULT_STEP_BUDGET = 15;

function timeoutForBudget(budget: number): number {
  const extraSteps = Math.max(0, budget - DEFAULT_STEP_BUDGET);
  return Math.min(MAX_TIMEOUT_MS, BASE_TIMEOUT_MS + extraSteps * PER_EXTRA_STEP_MS);
}

/**
 * Wraps a ctx-dependent tool-impl (bash, file I/O, code_artifact, browser_use,
 * ...) as a real ai-sdk `tool()` bound to a FIXED ctx -- these all take
 * `(args, ctx: ToolExecCtx)`, but when the ai-sdk tool-calling loop invokes a
 * plain `tool()`-wrapped function itself, the second argument it passes is
 * its OWN `ToolCallOptions` (toolCallId/messages/abortSignal), not our eve
 * ToolExecCtx -- calling e.g. bash.execute(args, thatOtherShape) would crash
 * immediately on `ctx.getSandbox is not a function`. This closes over the
 * real ctx once so every nested call gets it correctly.
 */
function ctxTool<TArgs>(impl: { description: string; inputSchema: unknown; execute: (args: TArgs, ctx: ToolExecCtx) => Promise<unknown> }, ctx: ToolExecCtx) {
  return tool({
    description: impl.description,
    inputSchema: impl.inputSchema as any,
    execute: (args: TArgs) => impl.execute(args, ctx),
  } as any);
}

/**
 * Sub-agent tool set -- deliberately NOT just "give it everything the root
 * has" (2026-07-18, "give sub agent tools too, use best judgement, think
 * well before you decide"). Split below into what a bounded, isolated
 * subtask (no visibility into the parent conversation, returns one final
 * text result) can actually make good use of, vs. what doesn't fit that
 * shape or is too high-risk/high-blast-radius to hand to a delegate:
 *
 * INCLUDED:
 *   - web_search, web_crawl -- research, already had these.
 *   - bash, list_files, write_file, edit_file, append_file -- real sandbox
 *     work (read/run/write code, inspect a project) for a delegated coding
 *     or file-based subtask. Same sandbox the parent turn is already using
 *     (see bash.ts's own description), so this is genuinely useful --
 *     e.g. "read these 6 files and refactor them" is a real bounded subtask.
 *   - code_artifact, python_coding -- sub-generation coding tools; already
 *     have their own internal timeout/abort wiring (task_analysis.ts's
 *     pattern), so nesting one inside a delegate's own tool loop is safe
 *     and consistent, not a new risk.
 *   - browser_use, browser_stop -- given together deliberately (never one
 *     without the other) so a delegate that opens a browser session can
 *     also clean it up itself; SUBAGENT_SYSTEM_PROMPT explicitly tells it
 *     to always call browser_stop before finishing.
 *
 * DELIBERATELY EXCLUDED:
 *   - choose -- pauses the turn to ask a live human to click an option. A
 *     sub-agent has no user-facing surface at all (its whole output is
 *     just text handed back to the parent) -- this would either hang
 *     forever waiting for a click that can never come, or be silently
 *     meaningless.
 *   - inject_credential, save_credential, list_credentials -- security-
 *     sensitive secret access. A delegate has no context on WHY it's being
 *     asked anything (it never sees the parent conversation), so it has no
 *     way to judge whether touching the user's stored credentials is even
 *     appropriate for this task -- that judgment call belongs at the root,
 *     not delegated blind.
 *   - restart_sandbox -- destructive to the ENTIRE shared session sandbox,
 *     not scoped to just this bounded subtask; a delegate having the power
 *     to nuke the parent's whole in-progress work is a wildly disproportionate
 *     blast radius for "complete one subtask and return."
 *   - create_skill, recall_skill, list_skills -- persistent, workspace-level
 *     artifact decisions (what gets permanently saved to the user's skill
 *     library). Better made by the root with the full conversation in view,
 *     not by an isolated one-shot delegate.
 *   - get_preview_url -- a UI side-effect tied to the visible chat's preview
 *     panel/polling, not a "return a text result" fit; a delegate causing
 *     the visible preview to flip while doing an unrelated subtask (e.g.
 *     research) would just be confusing.
 *   - agent (no recursive self-delegation) -- avoids uncontrolled recursive
 *     delegation trees; eve's own subagents.mdx already documents a real
 *     bug class around depth-capped nested delegation (see instructions.ts's
 *     2026-07-15 comment) that this sidesteps entirely by not going there.
 *   - task_analysis -- a meta-planning sub-generation tool; redundant here
 *     since the delegate is already a full reasoning loop for ONE narrow
 *     task -- adding a nested planner on top is extra cost/latency without
 *     a matching benefit at this scope.
 */
function delegateTools(ctx: ToolExecCtx | undefined) {
  const base = { web_search: tool(webSearch as any), web_crawl: tool(webCrawl as any) };
  if (!ctx) return base; // defensive: ctx-dependent tools need a real sandbox/session to bind to
  return {
    ...base,
    bash: ctxTool(bash, ctx),
    list_files: ctxTool(listFilesTool, ctx),
    write_file: ctxTool(writeFileTool, ctx),
    edit_file: ctxTool(editFileTool, ctx),
    append_file: ctxTool(appendFileTool, ctx),
    code_artifact: ctxTool(codeArtifact, ctx),
    python_coding: ctxTool(pythonCoding, ctx),
    browser_use: ctxTool(browserUse, ctx),
    browser_stop: ctxTool(browserStop, ctx),
  };
}

async function runDelegatedTask(
  model: LanguageModel,
  message: string,
  budget: number,
  outerCtx: ToolExecCtx | undefined
): Promise<{ text: string; steps: { finishReason?: string }[] }> {
  const t = withTimeoutSignal(outerCtx?.abortSignal, timeoutForBudget(budget), 'agent');
  // Same ctx nested tools bind to, except abortSignal is swapped for `t.signal`
  // -- so if THIS delegation's own timeout fires (not just the outer turn's
  // cancellation), any in-flight bash/browser/file call the sub-agent is
  // running gets cut off too, not just the top-level generateText polling loop.
  const delegateCtx: ToolExecCtx | undefined = outerCtx ? { ...outerCtx, abortSignal: t.signal } : undefined;
  try {
    return await withTransientRetry(() =>
      generateText({
        model,
        system: SUBAGENT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: message }],
        tools: delegateTools(delegateCtx),
        stopWhen: stepCountIs(budget),
        abortSignal: t.signal,
      })
    );
  } catch (err) {
    throw t.rethrow(err);
  } finally {
    t.clear();
  }
}

export const agentDelegate = {
  description:
    'Delegate a bounded subtask to a sub-agent, optionally on a SPECIFIC provider/model you choose (e.g. hand deep research to a Gemini model, ' +
    'careful planning to a Claude model, a rewrite/tone pass to a GPT model, or the CURRENT USER\'s own saved custom/BYOK provider from their ' +
    'settings page) — matching a real multi-model workflow instead of doing everything on a single model. The sub-agent has its own fresh context ' +
    '(it does NOT see this conversation — pack everything it needs into `message`) but is NOT limited to just reading/thinking: it can also call ' +
    'web_search/web_crawl, bash, list_files/write_file/edit_file/append_file, code_artifact, python_coding, and browser_use/browser_stop itself, ' +
    'in the SAME live sandbox as this conversation -- so a coding or file-based subtask ("read these files and refactor X", "write a script that ' +
    'does Y and run it") is a real thing you can delegate, not just research. Returns its final result as plain text, plus `truncated: true` if it ' +
    'ran out of steps before genuinely finishing (re-delegate a continuation using the partial result as context in that case, rather than ' +
    'treating it as complete). Pass `maxSteps` for a task you expect to be long/involved. Omit `provider`/`model` to delegate to a copy of ' +
    'yourself instead of a different model.',
  inputSchema: AgentDelegateInputSchema,
  outputSchema: AgentDelegateResultSchema,
  async execute(
    { message, provider, model, maxSteps }: { message: string; provider?: string; model?: string; maxSteps?: number },
    ctx?: ToolExecCtx
  ) {
    let note: string | undefined;
    let modelId: string;
    const budget = maxSteps ?? 15;
    const userId = ctx?.session?.auth?.current?.principalId;

    // ADDED (2026-07-18, "it can also specify... provider aerolink, model
    // gpt-5.6-sol" -- a user's own saved custom/BYOK provider from their
    // settings page, not a Gateway family): tried FIRST, before anything
    // Gateway-related, and regardless of whether this happens to be a
    // BYOK top-level turn or not -- unlike a Gateway request, targeting
    // the user's OWN endpoint with their OWN key never touches (or bills)
    // the platform's Gateway at all, so there's no cost-isolation reason
    // to block it on a BYOK turn the way a Gateway request is blocked
    // below. Only matched when `provider` ISN'T already a live Gateway
    // family name, so a real family (e.g. "anthropic") always resolves as
    // Gateway even if a user happened to save a custom provider under a
    // clashing label.
    if (provider && userId && !catalogMenu.providers.includes(provider)) {
      const custom = await resolveUserCustomProviderModel(userId, provider, model).catch(() => null);
      if (custom) {
        const { text, steps } = await runDelegatedTask(custom.model, message, budget, ctx);
        const truncated = isTruncatedFinish(steps, budget);
        return {
          result: text,
          modelUsed: `${custom.providerLabel}/${custom.modelId}`,
          stepsTaken: steps.length,
          truncated,
          note: truncated
            ? `Ran out of its ${budget}-step budget before finishing on its own — treat "result" as partial progress, not a final answer.`
            : undefined,
        };
      }
    }

    if (ctx?.byokModel) {
      // BYOK turns never touch the Gateway at any depth (same policy as
      // every other sub-generation tool — task_analysis,
      // python_coding, code_artifact) so the platform never
      // foots a Gateway bill on a turn the user is paying for with their
      // own key. A requested provider/model can't be honored here --
      // note this only means GATEWAY requests specifically; a named
      // custom-provider request was already tried just above and would
      // have returned by now on a match, so reaching here means either no
      // provider/model was given, or it genuinely didn't resolve as
      // either a Gateway family or one of the user's own saved providers.
      if (provider || model) {
        const custom = userId ? await listUserCustomProviderLabels(userId).catch(() => []) : [];
        note =
          `Custom provider/model requests aren't available on BYOK turns — ran on your connected model instead of ${[provider, model].filter(Boolean).join('/')}.` +
          (provider && custom.length > 0 && !custom.some(l => l.toLowerCase() === provider.toLowerCase())
            ? ` (If you meant one of your own saved providers, your options are: ${custom.join(', ')}.)`
            : '');
      }
      const { text, steps } = await runDelegatedTask(ctx.byokModel, message, budget, ctx);
      const truncated = isTruncatedFinish(steps, budget);
      return {
        result: text,
        modelUsed: 'byok',
        stepsTaken: steps.length,
        truncated,
        note: truncated
          ? [note, `Ran out of its ${budget}-step budget before finishing on its own — treat "result" as partial progress, not a final answer.`]
              .filter(Boolean)
              .join(' ')
          : note,
      };
    }

    if (provider && !catalogMenu.providers.includes(provider)) {
      // Reached only when the custom-provider attempt above found nothing
      // -- `provider` isn't a live Gateway family AND isn't one of this
      // user's own saved providers either. Fail clearly here instead of
      // letting it fall into resolveModelIdForProvider below, which would
      // throw a much less actionable "no models found" error.
      const custom = userId ? await listUserCustomProviderLabels(userId).catch(() => []) : [];
      throw new Error(
        `"${provider}" isn't a live Gateway provider (${catalogMenu.providers.join(', ')}) or one of your own saved providers` +
          (custom.length > 0 ? ` (${custom.join(', ')})` : ' (you have none saved yet)') +
          '. Check the spelling, or omit `provider` to delegate to a copy of yourself.'
      );
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

    // ADDED (2026-07-18, "so selecting doesn't take time"): an explicit
    // "provider/model" guess (as opposed to a provider-only auto-pick,
    // which is always resolved from the live catalog and therefore
    // already guaranteed valid) can still name a real-looking but wrong
    // id -- a typo, a retired model, a provider prefix that doesn't
    // actually pair with that model name. Left unchecked, that only
    // surfaces as an opaque failure deep inside generateText/Gateway
    // itself. Catch it here instead, immediately, with a clear message
    // pointing at real alternatives -- skipped entirely if the catalog
    // menu came up empty (a cold-start fetch hiccup; see getCatalogMenu's
    // fallback) so a validation-set outage never wrongly blocks a
    // perfectly valid model.
    if (model && catalogMenu.allModelIds.size > 0 && !catalogMenu.allModelIds.has(modelId)) {
      throw new Error(
        `"${modelId}" isn't in the live Gateway catalog right now. Known options: ${catalogMenu.menuText}.`
      );
    }

    const { text, steps } = await runDelegatedTask(gateway(modelId), message, budget, ctx);

    const truncated = isTruncatedFinish(steps, budget);
    return {
      result: text,
      modelUsed: modelId,
      stepsTaken: steps.length,
      truncated,
      note: truncated
        ? [note, `Ran out of its ${budget}-step budget before finishing on its own — treat "result" as partial progress, not a final answer.`]
            .filter(Boolean)
            .join(' ')
        : note,
    };
  },
};

agentDelegate.execute = safeExecute('agent', agentDelegate.execute) as typeof agentDelegate.execute;
