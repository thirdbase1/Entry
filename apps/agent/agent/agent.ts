import { defineAgent } from 'eve';
import { resolveModelIdForProvider } from './lib/model-catalog.js';

/**
 * The primary model id is resolved DYNAMICALLY from the live AI Gateway
 * catalog at module-eval time (top-level await) -- no model id is
 * hardcoded here. `resolveModelIdForProvider('anthropic')` always picks
 * whichever Anthropic model the Gateway currently ranks best, so this
 * file needs zero edits when a new Claude version ships.
 *
 * The result is a plain STRING id (not wrapped in `@ai-sdk/gateway`'s
 * `gateway()` helper). That distinction matters: eve's compiler has a
 * dedicated fast path for string model ids that resolves Gateway
 * context-window metadata directly from the model catalog by slug.
 * Passing a `gateway(...)`-wrapped LanguageModel object instead breaks
 * that lookup -- `@ai-sdk/gateway`'s wrapper sets `.provider = "gateway"`,
 * so eve's catalog lookup ends up searching for a slug like
 * "gateway/anthropic/claude-sonnet-4" that never exists in the catalog
 * (real slugs are e.g. "anthropic/claude-sonnet-4", no "gateway/" prefix)
 * -- confirmed the hard way via a real Vercel build failure: "Cannot
 * compile agent compaction because the primary compaction trigger model
 * ... does not have known AI Gateway context window metadata."
 *
 * This IS the shared root model for every user's turn, Gateway-routed,
 * by design -- kept this way on purpose (2026-07-10) rather than pointed
 * at a single direct provider, specifically so no one user's own
 * provider key foots the bill for every other user's root reasoning
 * step. BYOK turns get a fully separate, non-eve, non-Gateway execution
 * path instead -- see apps/web/middleware.ts + apps/web/lib/byok-run.ts.
 * That path never touches this model at all: it intercepts a BYOK-flagged
 * turn before it ever reaches eve's session runtime, so the Gateway-priced
 * root reasoning step below simply never runs for those turns.
 *
 * Compaction is enabled with eve's defaults (threshold 90% of context
 * window, uses the same model for summary generation).
 */
const primaryModelId = await resolveModelIdForProvider('anthropic');

export default defineAgent({
  model: primaryModelId,

  // Confirmed real bug (2026-07-11): root agent never set this, so Claude
  // never produced reasoning/thinking tokens at all for the default (no
  // model explicitly picked) chat path -- the eve session stream never
  // even emitted `reasoning.appended`/`reasoning.completed`, so there was
  // nothing for AIReasoningCard to render no matter what the UI did.
  // apps/web/app/api/direct/chat/route.ts (the explicit-model-picked path)
  // already set this per-turn via AI SDK's portable `reasoning` option --
  // this brings the root agent's default path to parity with it, using
  // the same provider-agnostic level set (agent-config.md's "Reasoning
  // effort"). "medium" is a sane default; provider/model determine which
  // levels actually change behavior.
  reasoning: 'medium',

  compaction: {
    // Summarize earlier turns when context window fills past 90%.
    // Uses eve's default (same model for summary generation).
    thresholdPercent: 0.9,
  },

  build: {
    // Prisma's generated client (packages/db/src/generated/internal/class.ts)
    // contains genuine `await import(...)` calls to load its WASM/native
    // query-compiler runtime (`@prisma/client/runtime/query_compiler_fast_bg
    // .postgresql.{mjs,wasm-base64.mjs}`) -- unavoidable, it's how Prisma
    // lazily loads its engine. Any authored tool that transitively touches
    // the DB (several still do, via @entry/copilot/@entry/db's `prisma` --
    // e.g. list_skills.ts, create_skill.ts, credential-vault.ts) pulled
    // this into eve's Rolldown bundler, which forced a second output chunk
    // and failed hard with "Expected one bundled authored module" --
    // confirmed via a real Vercel build failure. Declaring
    // `@prisma/client` external here (per eve's own build.externalDependencies
    // docs: "Prefer this when a package is sensitive to bundling") keeps
    // eve from inlining it at all for every authored module, including
    // tools -- it ships via server/node_modules in hosted output instead,
    // same as how @prisma/client is already handled for apps/web's Next.js
    // build (Next traces node_modules deps rather than bundling them).
    externalDependencies: [
      '@prisma/client',
      // Pulled in transitively via @prisma/adapter-pg (our driver adapter
      // for Neon/pg) -> @vercel/oidc, which has its own internal dynamic
      // import('./token.js') for OIDC token exchange. That created a THIRD
      // rolldown output chunk (a dynamic-entry chunk for token.js, on top
      // of the main entry + the shared rolldown-runtime helper chunk),
      // which is what was actually failing eve's single-chunk check even
      // after externalizing @prisma/client alone -- confirmed by
      // instrumenting eve's own getSingleRolldownChunk() locally to dump
      // the real output.filter(c=>c.type==='chunk') list.
      '@vercel/oidc',
    ],
  },
});
