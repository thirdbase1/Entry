import { generateText, tool, stepCountIs, type LanguageModel } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { z } from 'zod';
import { resolveModelIdForProvider, getCatalogMenu } from '../model-catalog.js';
import { resolveUserCustomProviderModel, listUserCustomProviderLabels, resolveDefaultSharedModel } from '../custom-model-provider.js';
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
import { agentChannel } from './agent_channel.js';
import { codeSearch } from './code_search.js';
import { codeIndex } from './code_index.js';
import { codeDiagnostics } from './code_diagnostics.js';
import { codeEmbedSearch } from './code_embed_search.js';
import { Sandbox as E2BSandbox } from 'e2b';
import { safeExecute } from './safe-execute.js';
import { withTransientRetry } from '../transient-provider-error.js';
import { withTimeoutSignal } from './with-timeout-signal.js';
import { DEFAULT_TOOL_TIMEOUT_MS } from './with-agent-timeout.js';
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
console.error('[BOOT-TRACE] tool-impls/agent.ts: before getCatalogMenu', new Date().toISOString());
const catalogMenu = await getCatalogMenu();
console.error('[BOOT-TRACE] tool-impls/agent.ts: after getCatalogMenu, providers=', catalogMenu.providers.length, new Date().toISOString());

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
        'rewriting tone/style. Omit both `provider` and `model` to default to the shared free model (HCNSec/freemodel.dev) — only pick a specific Gateway provider or custom provider when the task genuinely calls for it or the user explicitly asked for a specific model/provider.'
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
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .max(3600)
    .optional()
    .describe(
      'Optional explicit wall-clock ceiling for this whole delegated subtask, in seconds -- overrides the default budget-derived timeout ' +
        '(which scales with maxSteps, up to 600s/10min) when given. Set this directly for a subtask you know needs a specific amount of time.'
    ),
  // ADDED (2026-07-24, "Task-Scoped Tool Restricting"): a bounded subtask often only needs a small slice of the full
  // delegate tool set -- e.g. a pure research delegate never needs bash/write_file at all. Restricting the set (a) is a real
  // safety boundary for untrusted/generated instructions flowing into a delegated subtask (a research-only delegate literally
  // cannot run shell commands if bash isn't in this list), and (b) reduces execution noise/latency (fewer tool schemas in the
  // sub-agent's own context). Omit to keep the full default set (unchanged behavior).
  allowedTools: z
    .array(z.enum(["web_search", "web_crawl", "bash", "list_files", "write_file", "edit_file", "append_file", "code_artifact", "python_coding", "browser_use", "browser_stop", "agent_channel", "code_search", "code_index", "code_diagnostics", "code_embed_search"]))
    .optional()
    .describe(
      'Restrict this delegate to ONLY this list of tool names (e.g. ["web_search", "web_crawl"] for a read-only research delegate ' +
        'with no sandbox/shell access at all). Omit to give the delegate the full default tool set.'
    ),
  // ADDED (2026-07-24, "Ephemeral Sandbox Branching"): risky work (aggressive dependency upgrades, exploratory refactors,
  // "try rewriting this and see if it still builds") run against the SAME live sandbox as the parent turn by default -- a bad
  // outcome is real, persisted damage to the user's actual project. Setting this creates an isolated E2B snapshot-forked copy
  // of the current sandbox first and runs the whole delegated subtask against THAT copy instead -- the parent's real sandbox is
  // never touched. Returns the branched sandbox's id in the result so a human/parent can inspect it or explicitly bring changes
  // back over (e.g. via bash reading files from it) once the risky work is verified.
  isolated: z
    .boolean()
    .optional()
    .describe(
      'Set true to run this subtask in an ISOLATED branch of the current sandbox (an E2B snapshot fork) instead of the live one -- ' +
        'use this for risky/exploratory work (aggressive refactors, dependency upgrade experiments, "try this and see if it breaks") ' +
        'so a bad outcome never touches the real project. Only meaningful when this turn is running on the e2b sandbox backend; a ' +
        'note is returned instead of an error if branching is not available. Defaults to false (runs in the live shared sandbox, same ' +
        'as before).'
    ),
  // ADDED (2026-07-24, "Direct Inter-Agent Channels"): pass the SAME channel_id to two or more delegated sub-agents (in
  // separate agent tool calls) so they can hand each other structured data mid-task via the agent_channel tool, without either
  // one seeing the other's conversation. Purely informational here -- it just gets mentioned in this delegate's own instructions
  // so it knows to actually use agent_channel with this id; the real mechanism is the agent_channel tool itself.
  channel_id: z
    .string()
    .optional()
    .describe(
      'Optional shared channel name to tell this delegate about (e.g. "api-contract") -- it will be told to use the agent_channel ' +
        'tool with this id to coordinate with another concurrently-delegated sub-agent using the same id.'
    ),
});

// ADDED (2026-07-24, "Standardized Artifact Return Schemas"): a plain-text `result` forces the parent model to re-parse
// prose to pull out anything structured (a file patch, a JSON summary, a list of findings) the delegate produced --
// wasteful and error-prone at both ends. `artifacts` is optional, additive structured output alongside the existing
// `result` text (never a replacement -- `result` stays the human-readable summary either way).
const AgentArtifactSchema = z.object({
  type: z.enum(['patch', 'json', 'summary', 'file']),
  path: z.string().optional().describe('Relevant file path, if this artifact is about one specific file (e.g. type "patch" or "file").'),
  content: z.string().describe('The artifact content itself -- a unified diff for "patch", a JSON string for "json", plain text for "summary"/"file".'),
  description: z.string().optional(),
});

const AgentDelegateResultSchema = z.object({
  result: z.string(),
  modelUsed: z.string(),
  stepsTaken: z.number(),
  truncated: z.boolean().optional(),
  note: z.string().optional(),
  // Structured output objects the sub-agent explicitly emitted (see SUBAGENT_SYSTEM_PROMPT's ```agent-artifact convention) --
  // absent entirely when the delegate didn't produce any, so existing callers reading only `result` see no shape change.
  artifacts: z.array(AgentArtifactSchema).optional(),
  // ADDED (2026-07-24, "Real-Time Telemetry and Intermediate Callbacks"): a bounded log of what happened at each step
  // (tool called + a short outcome summary), captured via generateText's own onStepFinish as the subtask runs -- not truly
  // "live"/streamed to the parent mid-flight (this tool call itself only resolves once, like any other tool result), but it
  // gives the parent real visibility into HOW a multi-step delegation got to its result instead of just the final text, and is
  // a building block for a future live-streaming version (the per-step data already exists here, just batched instead of
  // streamed).
  progressLog: z.array(z.string()).optional(),
  // ADDED (2026-07-24, "Ephemeral Sandbox Branching"): present only when `isolated: true` was requested and branching
  // actually happened -- the id of the forked sandbox the subtask ran in, so a human or the parent can inspect it directly
  // (e.g. "bash: read file X from sandbox <id>") or decide to bring specific changes back over.
  isolatedSandboxId: z.string().optional(),
});

function buildSubagentSystemPrompt(opts: { isolated?: boolean; channelId?: string }): string {
  let prompt =
    'You are a focused sub-agent completing ONE delegated task for a parent AI agent. You do not see the parent conversation — ' +
    'only the task message you were given. Answer completely and directly; your entire reply is returned as-is to the parent, ' +
    'which will use it to continue helping its own user. ' +
    'You also have bash, list_files/write_file/edit_file/append_file, code_artifact, python_coding, web_search/web_crawl, ' +
    'browser_use/browser_stop, code_search (fast ripgrep text/regex search), code_index (tree-sitter structural file outline: ' +
    'functions/classes/methods with real line numbers), code_diagnostics (real tsc/pyright/cargo-check compiler diagnostics), and ' +
    'code_embed_search (semantic "by meaning" code search -- index a path once, then search it by natural language). ' +
    'IMPORTANT: bash/file/browser tools run in the SAME live sandbox as the parent turn\'s ongoing project ' +
    '-- any file you write or command you run is real and persists, not an isolated scratch copy' +
    (opts.isolated
      ? ', EXCEPT this specific task, which is running in an ISOLATED BRANCHED COPY of that sandbox -- changes here are ' +
        'safe experiments and will NOT automatically affect the real project unless the parent explicitly pulls them back over. ' +
        'Say so clearly in your result if you made changes worth keeping.'
      : '.') +
    ' If you start a browser_use session, always call browser_stop when you are done with it (or before finishing if you still ' +
    'have one open), so it is not left running/billing after your task ends. ' +
    "If you're running low on remaining steps and won't finish in time, don't trail off mid-thought — stop and clearly summarize what you " +
    "did complete, what's still left, and what the parent should do next (e.g. re-delegate the remainder with your partial result as context). " +
    'If your task produces something structured worth returning as data (a file patch/diff, a JSON object, a distinct list of findings) ' +
    'in ADDITION to your normal text answer, end your reply with one or more fenced blocks like:\n' +
    '```agent-artifact\n{"type": "patch" | "json" | "summary" | "file", "path": "optional/file/path", "content": "...", "description": "optional"}\n```\n' +
    'This is OPTIONAL -- only do it when there is genuinely something structured to hand back, never as a substitute for a real text answer.';
  if (opts.channelId) {
    prompt +=
      ` You have access to a shared channel named "${opts.channelId}" via the agent_channel tool -- use it to read/write/append ` +
      'structured data another concurrently-delegated sub-agent using the same channel_id may be reading or writing, to coordinate ' +
      'without going back through the parent.';
  }
  return prompt;
}

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
// FIXED (2026-07-23, real user-confirmed bug: "model stop under 2 minutes
// ... related to tool call" -- traced to exactly this constant). This was
// the ONE tool-impl in this file still defaulting to a short timeout --
// every sibling (bash.ts, code_artifact.ts, python_coding.ts,
// task_analysis.ts) already defaults straight to the full
// DEFAULT_TOOL_TIMEOUT_MS (10 min) per the 2026-07-20 "bump the limit of
// everything up to 10 minutes by default" pass, but this file's own
// budget-scaling formula was never updated to match -- at the DEFAULT_STEP_BUDGET
// (15, i.e. whenever a caller delegates without explicitly passing a
// larger `maxSteps`, the overwhelmingly common case), `extraSteps` is 0
// and the old 90_000 BASE_TIMEOUT_MS applied UNSCALED -- a hard 90-second
// ceiling on every default-budget delegation, well under the 10-minute
// ceiling every other tool already gets. A delegated subtask doing
// real work (a web_search + web_crawl + reasoning + write-up alone
// routinely exceeds 90s) would silently get cut off mid-work with
// nothing surfaced beyond a generic timeout error -- reads exactly like
// "the model just stopped."
// BASE_TIMEOUT_MS now equals the same 10-minute default every sibling
// tool already uses -- the budget-scaling formula below is kept for
// callers who explicitly request a much larger `maxSteps` (or an even
// higher explicit `timeout_seconds`, which bypasses this formula
// entirely -- see runDelegatedTask's `explicitTimeoutMs` param), but the
// DEFAULT case (no maxSteps given) no longer gets an artificially short
// ceiling no other tool in this codebase has.
const BASE_TIMEOUT_MS = DEFAULT_TOOL_TIMEOUT_MS;
const PER_EXTRA_STEP_MS = 8_000;
const MAX_TIMEOUT_MS = DEFAULT_TOOL_TIMEOUT_MS;
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
function delegateTools(ctx: ToolExecCtx | undefined, allowedTools?: string[]) {
  const base = { web_search: tool(webSearch as any), web_crawl: tool(webCrawl as any) };
  const full = !ctx
    ? base // defensive: ctx-dependent tools need a real sandbox/session to bind to
    : {
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
        agent_channel: ctxTool(agentChannel, ctx),
        code_search: ctxTool(codeSearch, ctx),
        code_index: ctxTool(codeIndex, ctx),
        code_diagnostics: ctxTool(codeDiagnostics, ctx),
        code_embed_search: ctxTool(codeEmbedSearch, ctx),
      };
  // ADDED (2026-07-24, "Task-Scoped Tool Restricting"): filter down to only the caller-requested subset when given -- see
  // AgentDelegateInputSchema's `allowedTools` field for the rationale. An unknown/misspelled name in the list is silently
  // ignored rather than erroring (schema validation already constrains it to a real z.enum of known tool names, so this can
  // only happen if the enum and this object's keys ever drift -- fails safe by just not including it, rather than crashing the
  // whole delegation over one bad name).
  if (!allowedTools || allowedTools.length === 0) return full;
  const allowedSet = new Set(allowedTools);
  const entries = Object.entries(full as Record<string, unknown>).filter(([name]) => allowedSet.has(name));
  return Object.fromEntries(entries) as typeof full;
}

// ADDED (2026-07-24, "Ephemeral Sandbox Branching"): forks the CURRENT live sandbox into an isolated copy via E2B's real
// snapshot primitive (confirmed API: `sandbox.createSnapshot()` -> `{snapshotId}`, then `E2BSandbox.create(snapshotId, ...)`
// spawns an independent new sandbox starting from that exact filesystem+memory state -- "one-to-many", the original keeps
// running untouched; see e2b-backend.ts's own doc comment for the same primitive used there for template reuse). Returns
// null (never throws) when branching isn't possible -- e.g. this turn is on the vercel() sandbox backend instead of e2b(), or
// the live E2B API key is missing -- so an isolated request degrades to a clear note instead of failing the whole delegation.
async function tryBranchSandbox(
  baseSandboxId: string
): Promise<{
  id: string;
  run(opts: { command: string; env?: Record<string, string>; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
} | null> {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) return null;
  try {
    const snapshot = await E2BSandbox.createSnapshot(baseSandboxId);
    const branched = await E2BSandbox.create(snapshot.snapshotId, { apiKey, timeoutMs: 15 * 60 * 1000 });
    return {
      id: branched.sandboxId,
      run: async (opts: { command: string; env?: Record<string, string>; signal?: AbortSignal }) => {
        // Every other tool in this file assumes paths resolve relative to /workspace (see e2b-backend.ts's own
        // resolvePath()) -- without an explicit cwd here, commands would run relative to E2B's default user home dir
        // instead, silently breaking every relative-path file op the branched delegate makes. `env` forwarded so tools
        // that rely on it (browser_use's AGENT_BROWSER_ARGS) still work against the branched sandbox. Matches
        // e2b-backend.ts's own real run() exactly (cwd/envs/timeoutMs only -- that implementation never actually
        // forwards its own declared `abortSignal` option into the real E2B SDK call either, so `signal` is accepted
        // on this wrapper's input type for interface compatibility but intentionally not passed further, same as there).
        const r = await branched.commands.run(opts.command, { cwd: '/workspace', envs: opts.env, timeoutMs: 10 * 60 * 1000 });
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      },
    };
  } catch (err) {
    console.warn('[agent] isolated sandbox branch failed, falling back to live sandbox:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ADDED (2026-07-24, "Standardized Artifact Return Schemas"): pulls any trailing ```agent-artifact fenced JSON blocks
// (see buildSubagentSystemPrompt's convention) out of the sub-agent's final text, parses each into the AgentArtifactSchema
// shape, and returns the ORIGINAL text with those blocks stripped out (so the human-facing `result` doesn't duplicate the
// same content as raw JSON alongside the structured `artifacts` array). A malformed block is skipped rather than thrown --
// a sub-agent producing slightly-invalid JSON should still return its normal text result cleanly.
function extractArtifacts(text: string): { cleanText: string; artifacts: { type: string; path?: string; content: string; description?: string }[] } {
  const artifacts: { type: string; path?: string; content: string; description?: string }[] = [];
  const re = /```agent-artifact\s*\n([\s\S]*?)\n?```/g;
  const cleanText = text.replace(re, (_match, jsonText) => {
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string' && typeof parsed.content === 'string') {
        artifacts.push({ type: parsed.type, path: parsed.path, content: parsed.content, description: parsed.description });
      }
    } catch {
      // Malformed artifact JSON -- drop it silently, keep the rest of the result intact.
    }
    return '';
  }).trim();
  return { cleanText, artifacts };
}

interface RunDelegatedTaskOptions {
  allowedTools?: string[];
  isolated?: boolean;
  channelId?: string;
}

async function runDelegatedTask(
  model: LanguageModel,
  message: string,
  budget: number,
  outerCtx: ToolExecCtx | undefined,
  explicitTimeoutMs?: number,
  options: RunDelegatedTaskOptions = {}
): Promise<{
  text: string;
  steps: { finishReason?: string }[];
  artifacts: { type: string; path?: string; content: string; description?: string }[];
  progressLog: string[];
  isolatedSandboxId?: string;
}> {
  const t = withTimeoutSignal(outerCtx?.abortSignal, explicitTimeoutMs ?? timeoutForBudget(budget), 'agent');
  // Same ctx nested tools bind to, except abortSignal is swapped for `t.signal`
  // -- so if THIS delegation's own timeout fires (not just the outer turn's
  // cancellation), any in-flight bash/browser/file call the sub-agent is
  // running gets cut off too, not just the top-level generateText polling loop.
  let delegateCtx: ToolExecCtx | undefined = outerCtx ? { ...outerCtx, abortSignal: t.signal } : undefined;
  let isolatedSandboxId: string | undefined;

  // "Ephemeral Sandbox Branching" -- fork the live sandbox once up front (before any tool call runs), so EVERY bash/file
  // call this delegation makes for its whole lifetime goes to the branch, not just some of them.
  if (options.isolated && outerCtx) {
    try {
      const baseSandbox = await outerCtx.getSandbox();
      const branched = await tryBranchSandbox(baseSandbox.id);
      if (branched) {
        isolatedSandboxId = branched.id;
        delegateCtx = { ...outerCtx, abortSignal: t.signal, getSandbox: async () => branched as any };
      }
    } catch (err) {
      console.warn('[agent] isolated branch setup failed, continuing on the live sandbox:', err instanceof Error ? err.message : err);
    }
  }

  // "Real-Time Telemetry and Intermediate Callbacks" -- bounded per-step log (tool name + a short outcome summary),
  // captured as the subtask actually runs rather than only ever seeing the final text.
  const progressLog: string[] = [];
  const MAX_PROGRESS_ENTRIES = 40;
  const MAX_ENTRY_CHARS = 220;

  try {
    const { text, steps } = await withTransientRetry(() =>
      generateText({
        model,
        system: buildSubagentSystemPrompt({ isolated: Boolean(isolatedSandboxId), channelId: options.channelId }),
        messages: [{ role: 'user', content: message }],
        tools: delegateTools(delegateCtx, options.allowedTools),
        stopWhen: stepCountIs(budget),
        abortSignal: t.signal,
        onStepFinish: step => {
          if (progressLog.length >= MAX_PROGRESS_ENTRIES) return;
          const calls = (step.toolCalls ?? []) as { toolName?: string }[];
          if (calls.length > 0) {
            const names = calls.map(c => c.toolName).filter(Boolean).join(', ');
            progressLog.push(`step ${progressLog.length + 1}: called ${names}`);
          } else if (step.text) {
            progressLog.push(`step ${progressLog.length + 1}: reasoned — ${step.text.slice(0, MAX_ENTRY_CHARS)}`);
          }
        },
      })
    );
    const { cleanText, artifacts } = extractArtifacts(text);
    return { text: cleanText, steps, artifacts, progressLog, isolatedSandboxId };
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
    'yourself instead of a different model. Also has code_search (ripgrep), code_index (tree-sitter structural outline), code_diagnostics ' +
    '(real tsc/pyright/cargo-check), and code_embed_search (semantic code search) for real code-intelligence work, not just guessing from ' +
    'reading files. Pass `allowedTools` to restrict a delegate to a safe subset (e.g. research-only, no shell access). Pass `isolated: true` ' +
    'to run risky/exploratory work in a branched copy of the sandbox instead of the live project. Pass the same `channel_id` to two ' +
    'delegated sub-agents so they can hand each other structured data mid-task via the agent_channel tool. The result also includes an ' +
    'optional `artifacts` array (structured patches/JSON/summaries the delegate explicitly produced) and `progressLog` (a short per-step ' +
    'trace of what it did along the way), on top of the plain-text `result`.',
  inputSchema: AgentDelegateInputSchema,
  outputSchema: AgentDelegateResultSchema,
  async execute(
    {
      message,
      provider,
      model,
      maxSteps,
      timeout_seconds,
      allowedTools,
      isolated,
      channel_id,
    }: {
      message: string;
      provider?: string;
      model?: string;
      maxSteps?: number;
      timeout_seconds?: number;
      allowedTools?: string[];
      isolated?: boolean;
      channel_id?: string;
    },
    ctx?: ToolExecCtx
  ) {
    let note: string | undefined;
    let modelId: string;
    const budget = maxSteps ?? 15;
    const explicitTimeoutMs = typeof timeout_seconds === 'number' && timeout_seconds > 0 ? timeout_seconds * 1000 : undefined;
    const userId = ctx?.session?.auth?.current?.principalId;
    const delegateOptions = { allowedTools, isolated, channelId: channel_id };

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
        const { text, steps, artifacts, progressLog, isolatedSandboxId } = await runDelegatedTask(custom.model, message, budget, ctx, explicitTimeoutMs, delegateOptions);
        const truncated = isTruncatedFinish(steps, budget);
        return {
          result: text,
          modelUsed: `${custom.providerLabel}/${custom.modelId}`,
          stepsTaken: steps.length,
          truncated,
          note: truncated
            ? `Ran out of its ${budget}-step budget before finishing on its own — treat "result" as partial progress, not a final answer.`
            : undefined,
          artifacts: artifacts.length > 0 ? artifacts : undefined,
          progressLog: progressLog.length > 0 ? progressLog : undefined,
          isolatedSandboxId,
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
      const { text, steps, artifacts, progressLog, isolatedSandboxId } = await runDelegatedTask(ctx.byokModel, message, budget, ctx, explicitTimeoutMs, delegateOptions);
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
        artifacts: artifacts.length > 0 ? artifacts : undefined,
        progressLog: progressLog.length > 0 ? progressLog : undefined,
        isolatedSandboxId,
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
      // DEFAULT SUB-AGENT MODEL (owner ask 2026-07-27: "free model and
      // hncsec should be the default sub agent... model should only call
      // another provider if user specifically ask"): no explicit
      // provider/model was given, so try a shared free model FIRST --
      // this is a real API call/cost difference from the old default
      // (a paid Gateway "anthropic" call on every no-ask delegate), not
      // just a label change. Only falls back to the Gateway anthropic
      // family (the pre-existing "copy of the root's own model family"
      // behavior) when no shared provider is configured at all.
      const shared = await resolveDefaultSharedModel().catch(() => null);
      if (shared) {
        const { text, steps, artifacts, progressLog, isolatedSandboxId } = await runDelegatedTask(shared.model, message, budget, ctx, explicitTimeoutMs, delegateOptions);
        const truncated = isTruncatedFinish(steps, budget);
        return {
          result: text,
          modelUsed: `${shared.providerLabel}/${shared.modelId}`,
          stepsTaken: steps.length,
          truncated,
          note: truncated
            ? `Ran out of its ${budget}-step budget before finishing on its own — treat "result" as partial progress, not a final answer.`
            : undefined,
          artifacts: artifacts.length > 0 ? artifacts : undefined,
          progressLog: progressLog.length > 0 ? progressLog : undefined,
          isolatedSandboxId,
        };
      }
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

    const { text, steps, artifacts, progressLog, isolatedSandboxId } = await runDelegatedTask(gateway(modelId), message, budget, ctx, explicitTimeoutMs, delegateOptions);

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
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      progressLog: progressLog.length > 0 ? progressLog : undefined,
      isolatedSandboxId,
    };
  },
};

agentDelegate.execute = safeExecute('agent', agentDelegate.execute) as typeof agentDelegate.execute;
