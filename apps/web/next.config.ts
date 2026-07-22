import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const nextConfig: NextConfig = {
  // Standalone output: see the long comment block near the bottom of this
  // file (search "MANUAL BUILD OUTPUT API DEPLOYMENT") for why this is
  // required — Vercel's own build orchestration (both `vercel build` and a
  // real `vercel --prod` remote build) reproducibly kills `next build`
  // with zero error output, while a plain `next build`/`npm run build` run
  // outside that orchestration layer always succeeds. Standalone output
  // lets us build normally and hand-assemble the Vercel deployment
  // ourselves via the Build Output API, bypassing the broken orchestration
  // entirely.
  output: 'standalone',
  // Bundles the raw migration.sql files into the standalone/serverless
  // output for the one route that needs to read them at runtime
  // (/api/admin/db/migrate) — Next's output file tracing only follows the
  // actual JS import graph by default, so these plain .sql files (never
  // `import`ed, only read from disk at request time) wouldn't otherwise
  // make it into the deployed bundle at all. See that route's file
  // comment for why it exists: Neon's Vercel integration doesn't let the
  // CLI export the real production DATABASE_URL, so `prisma migrate
  // deploy` can only safely run from inside a deployed function, not a
  // local shell.
  outputFileTracingIncludes: {
    '/api/admin/db/migrate': ['../../packages/db/prisma/migrations/**/*'],
  },
  // Vercel's build containers report "2 cores, 8 GB" in their UI, but
  // Node's os.cpus().length (which Next.js's `experimental.cpus` default
  // derives from) often reads the underlying HOST's full core count on
  // containerized infra, not the cgroup-limited allocation actually given
  // to this build. Confirmed the hard way: local reproduction via a real
  // `vercel build` showed "Collecting page data using 16 workers" — way
  // more workers than the "2 cores" the container is actually billed/
  // limited to. Each worker independently loads the full server module
  // graph (Better Auth, Prisma, transpilePackages above), so 16 concurrent workers on an 8 GB box
  // reliably exceeds available memory and gets SIGKILLed by the OOM
  // killer with zero error output (looks like a silent "exited with 1"
  // right after "Compiled successfully" — no stack trace, no OOM message,
  // because the killed worker process never gets a chance to report
  // anything). Capping to 1 worker serializes page-data collection —
  // slower, but bounded, predictable memory use that fits the box.
  experimental: {
    // NOTE: trustHostHeader is NOT settable here -- next/dist/build/index.js
    // bakes `experimental.trustHostHeader` into the standalone server.js's
    // embedded runtime config straight from ci-info's `hasNextSupport`
    // (NOW_BUILDER env var), unconditionally overriding whatever this
    // config says. See scripts/build-vercel-output.sh's NOW_BUILDER=1 for
    // the actual fix -- that's the one that matters, this comment is just
    // here so nobody re-adds a dead `trustHostHeader: true` line here again.
    cpus: 1,
    // Switched from child_process forking (workerThreads: false) to
    // worker_threads (true): a real `vercel build`/`vercel --prod` run
    // (both locally in the dev sandbox and on Vercel's own remote
    // builder) reproducibly died with zero error output right between
    // "Skipping validation of types" and "Collecting page data using N
    // workers" — i.e. during the page-data worker's own startup, before
    // it ever got a chance to run or log anything. A plain `next build`
    // run outside any Vercel orchestration layer never hit this, even
    // with the exact same node_modules/env. worker_threads spins up a
    // new V8 isolate inside the *same* OS process (no fork()/clone()
    // needed), sidestepping whatever is blocking that nested child-
    // process creation specifically when Next.js's build is itself
    // invoked as a child of Vercel's own build orchestration (CLI or
    // remote container).
    workerThreads: true,
  },
  // Our own internal workspace packages ship raw TS source, so Next needs
  // transpilePackages to run them through its compiler.
  transpilePackages: [
    '@entry/agent',
    '@entry/db',
    '@entry/auth',
    '@entry/cache',
    '@entry/features',
    '@entry/copilot',
    '@entry/mail',
    '@entry/oauth',
    '@entry/queue',
    '@entry/ws',
  ],
  // `xdg-app-paths` (transitively pulled in by prisma tooling)
  // auto-derives an app name from the CALLING module's real Node
  // `.filename` when webpack bundles it, `module.filename` doesn't exist
  // on webpack's module wrapper, so `path.parse(undefined)` throws a real
  // ERR_INVALID_ARG_TYPE. Fix: keep this whole chain un-bundled
  // (externalized) so it's loaded via real Node `require` at runtime.
  // `@vercel/sandbox` itself was removed from this list 2026-07-16 — the
  // direct-chat sandbox (lib/direct-chat/sandbox.ts) no longer uses it at
  // all (migrated to E2B, see that file's comment), and nothing else in
  // apps/web imports it anymore.
  serverExternalPackages: ['@prisma/client', 'xdg-app-paths', 'xdg-portable'],
  // Our internal packages' raw-TS source uses NodeNext-style relative
  // imports ending in `.js` that point at sibling `.ts` files (e.g.
  // `./adapter.js` -> `./adapter.ts`). Turbopack doesn't resolve that
  // mapping yet (tracked upstream: github.com/vercel/next.js/issues/82945,
  // still open as of Next 16.2.10 — confirmed by an actual `next build`
  // failing with "Module not found" for every such import). webpack's
  // `resolve.extensionAlias` is the documented workaround, so this app
  // builds with `next build --webpack` until Turbopack gains parity.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };

    // `e2b`'s CJS dist has a dynamic `require(expr)` deep in its own
    // dependency tree, which webpack can't statically analyze and warns
    // about ("Critical dependency: the request of a dependency is an
    // expression"). Tried externalizing it via serverExternalPackages
    // (2026-07-16) to silence this the same way `xdg-app-paths` is
    // handled above — that broke production at runtime instead: e2b's
    // CJS dist does `require('chalk')`, and chalk v5+ is pure ESM, so an
    // unbundled e2b crashes every request with `ERR_REQUIRE_ESM` the
    // moment Node's own `require()` (not webpack's) hits it. Bundling it
    // (i.e. NOT externalizing) is what actually works at runtime — the
    // warning itself is genuinely harmless in that case (the dynamic
    // require path it's warning about is never reached by any code this
    // app actually calls), so it's suppressed here by message pattern
    // instead of by externalizing the package.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      { module: /node_modules\/e2b\//, message: /Critical dependency: the request of a dependency is an expression/ },
    ];

    // Explicit webpack alias for '@/ — Vercel's Next.js 16 build adapter
    // ("Applying modifyConfig from Vercel") breaks JsConfigPathsPlugin
    // resolution for specific @/ imports. Adding a direct webpack alias
    // bypasses the plugin and reliably resolves all @/ paths.
    // See: https://nextjs.org/docs/messages/invalid-resolve-alias
    if (config.resolve.alias && typeof config.resolve.alias === 'object' && !Array.isArray(config.resolve.alias)) {
      // NOTE: the alias key must be '@' (no trailing slash). Webpack's
      // enhanced-resolve AliasPlugin does a prefix match by checking
      // request === key OR request.startsWith(key + '/') — so a key of
      // '@/' would require the request to start with '@//' (wrong,
      // never matches). '@' is correct: '@/components/x'.startsWith('@' + '/')
      // = '@/components/x'.startsWith('@/') = true, then the matched
      // prefix '@' is replaced, leaving '/components/x' appended to
      // our resolved path.
      config.resolve.alias['@'] = resolve(__dirname, './');
    }

    return config;
  },
};

// RETIRED (2026-07-22): this used to be `export default withEve(nextConfig,
// { eveRoot: ... })`, mounting apps/agent's whole eve project (agent.ts,
// instructions.md, tools/, sandbox/) as in-process `/eve/v1/*` routes
// inside this Next.js app. eve is fully decommissioned now -- every chat
// (new and resumed) is served by /api/direct/chat, a plain Vercel AI SDK
// implementation with no eve dependency at all. Removing withEve() drops
// the `eve` package from this app's server bundle entirely (smaller
// bundle, one less framework mounted into every cold start).
export default nextConfig;
