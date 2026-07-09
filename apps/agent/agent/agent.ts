import { defineAgent } from 'eve';
import { resolveModelIdForProvider } from './lib/model-catalog.js';

/**
 * The primary model id is resolved DYNAMICALLY from the live AI Gateway
 * catalog at module-eval time (top-level await) — no model id is
 * hardcoded here. `resolveModelIdForProvider('anthropic')` always picks
 * whichever Anthropic model the Gateway currently ranks best, so this
 * file needs zero edits when a new Claude version ships.
 *
 * The result is a plain STRING id (not wrapped in `@ai-sdk/gateway`'s
 * `gateway()` helper). That distinction matters: eve's compiler has a
 * dedicated fast path for string model ids that resolves Gateway
 * context-window metadata directly from the model catalog by slug.
 * Passing a `gateway(...)`-wrapped LanguageModel object instead breaks
 * that lookup — `@ai-sdk/gateway`'s wrapper sets `.provider = "gateway"`,
 * so eve's catalog lookup ends up searching for a slug like
 * "gateway/anthropic/claude-sonnet-4" that never exists in the catalog
 * (real slugs are e.g. "anthropic/claude-sonnet-4", no "gateway/" prefix)
 * — confirmed the hard way via a real Vercel build failure: "Cannot
 * compile agent compaction because the primary compaction trigger model
 * ... does not have known AI Gateway context window metadata."
 *
 * Per the eve blog post:
 * > "The agent.ts file is where you configure the agent itself. You can
 * > define the model with one line, with provider fallbacks supported
 * > through AI Gateway, and compaction, model options, and other optional
 * > fields are there when you need them."
 *
 * Compaction is enabled with eve's defaults (threshold 90% of context
 * window, uses the same model for summary generation).
 */
const primaryModelId = await resolveModelIdForProvider('anthropic');

export default defineAgent({
  model: primaryModelId,

  compaction: {
    // Summarize earlier turns when context window fills past 90%.
    // Uses eve's default (same model for summary generation).
    thresholdPercent: 0.9,
  },

  build: {
    // Prisma's generated client (packages/db/src/generated/internal/class.ts)
    // contains genuine `await import(...)` calls to load its WASM/native
    // query-compiler runtime (`@prisma/client/runtime/query_compiler_fast_bg
    // .postgresql.{mjs,wasm-base64.mjs}`) — unavoidable, it's how Prisma
    // lazily loads its engine. Any authored tool that transitively touches
    // the DB (doc_compose.ts / make_it_real.ts, via @entry/copilot's
    // addDoc() -> @entry/db's `prisma`) pulled this into eve's Rolldown
    // bundler, which forced a second output chunk and failed hard with
    // "Expected one bundled authored module" — confirmed via two separate
    // real Vercel build failures (first on doc_compose.ts, then on
    // make_it_real.ts once the first bundling issue was fixed). Declaring
    // `@prisma/client` external here (per eve's own build.externalDependencies
    // docs: "Prefer this when a package is sensitive to bundling") keeps
    // eve from inlining it at all for every authored module, including
    // tools — it ships via server/node_modules in hosted output instead,
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
      // after externalizing @prisma/client alone — confirmed by
      // instrumenting eve's own getSingleRolldownChunk() locally to dump
      // the real output.filter(c=>c.type==='chunk') list.
      '@vercel/oidc',
    ],
  },
});
