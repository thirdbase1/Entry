import { defineDynamic, defineInstructions } from 'eve/instructions';
import { buildPersonaInstructions } from './lib/persona.js';

/**
 * Root = shared persona only.
 *
 * There used to be a `<model_routing>` block here plus a `run_model` tool:
 * whenever the user picked a specific model in chat-config.tsx's selector,
 * the request still went to THIS agent (eve's fixed `model:`, i.e. Claude)
 * first, which was instructed to detect a `requestedModel`/`byokModelId`
 * hint in its context and immediately delegate the whole turn to
 * `run_model` instead of answering itself.
 *
 * Removed (2026-07-10) because that indirection was the actual root cause
 * of three separate real bugs: (1) `run_model` used a single blocking
 * `generateText` call, so the delegated model's answer never streamed —
 * root just relayed the whole finished text at once; (2) no reasoning/
 * thinking content was ever requested or forwarded through that relay;
 * (3) for anything conversational (e.g. "what model are you"), root would
 * sometimes just answer as itself instead of reliably delegating, so a
 * user who picked DeepSeek would get told "I'm Claude" — an instruction a
 * system prompt can ask an LLM to follow but can never fully guarantee.
 *
 * Fix: any explicit model selection (Gateway slug or BYOK) now routes to
 * apps/web/app/api/direct/chat instead, which resolves that model directly
 * and IS the whole turn's model — no relay, no possibility of a different
 * model answering identity questions on its behalf. See chat-interface.tsx
 * for the routing decision. This eve agent (root Claude, resolved via
 * model-catalog.ts) now only ever handles a turn when nothing was
 * explicitly picked (the "Default" option) — a real default, not a
 * required first hop for every turn.
 *
 * BUG (2026-07-15, user-reported and reproduced with a live trace):
 * "AI_NoSuchToolError: Model tried to call unavailable tool 'agent'.
 * Available tools: choose, web_crawl, web_search, task_analysis,
 * code_artifact, python_coding, bash, browser_use, list_files,
 * save_credential, list_credentials, inject_credential, create_skill,
 * list_skills, recall_skill, get_preview_url, restart_sandbox" — no
 * `agent` in that list. This was a STATIC `defineInstructions({ markdown:
 * buildPersonaInstructions() })`, i.e. `includeAgentDelegation` defaulted
 * true unconditionally for every session — root AND every subagent copy
 * spawned via the built-in `agent` tool alike, since per eve's own
 * subagents.mdx a built-in-tool child "inherits" the parent's
 * instructions verbatim (a copy of the same agent). But per that same
 * doc: "Subagent delegation is capped by default... At the configured
 * depth, eve stops advertising subagent tools, including... the built-in
 * `agent` tool" — so a child session that's at/past that depth cap
 * genuinely has no `agent` tool anymore, while its (inherited, static)
 * instructions still confidently told it to use one. That mismatch is
 * exactly what the trace shows: a delegated "Claude" child tried to
 * delegate again, got told the tool flat-out doesn't exist for it, and
 * the turn died there.
 *
 * Fix: switched to `defineDynamic` so this resolves per-session instead
 * of once at build time. `ctx.session.parent` is present only for a
 * child subagent session (per eve's session-context.md), absent for the
 * true root. Only the root is ever told about `agent` delegation now —
 * every child, at any depth, gets the non-delegation phrasing. This is
 * deliberately conservative (a depth-1 child technically still has
 * `agent` available today) rather than trying to thread the exact
 * configured depth cap through here: a child recursively delegating
 * further is marginal value anyway, and "never mismatched" beats "right
 * up until the last allowed depth."
 */
// `DynamicResolveContext.session` (the type `defineDynamic`'s
// `session.started` handler gets) only declares `{ id, auth }` -- but
// per eve's own session-context.md, the runtime object always carries an
// optional `parent` too (same public/runtime type gap as
// `ctx.getSandbox()`'s `run()` missing `env`, see tool-impls/types.ts).
// Narrow, local cast right at the read site rather than widening
// anything upstream, since this is the only place in the app that reads
// session lineage from an instructions resolver.
type SessionWithParent = { parent?: { sessionId: string; callId: string; rootSessionId: string } };

// REMOVED (2026-07-15, explicit user request): this used to resolve
// `rootModelId` here and thread it into persona.ts as `runningAs` so the
// root agent could recite its exact provider/model when asked. The user
// does not want the model's name/provider injected via system prompt at
// all -- identity questions get whatever answer the model would give on
// its own, no steering either way. See persona.ts's own comment.
export default defineDynamic({
  events: {
    'session.started': (_event, ctx) => {
      const isChild = !!(ctx.session as unknown as SessionWithParent).parent;
      return defineInstructions({
        markdown: buildPersonaInstructions({ includeAgentDelegation: !isChild }),
      });
    },
  },
});
