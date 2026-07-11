import type { NextConfig } from 'next';
import { withEve } from 'eve/next';
import { resolve } from 'node:path';

// Resolve an ABSOLUTE path to apps/agent, anchored to this config file's own
// location on disk (not process.cwd()). eve's withEve() resolves a relative
// eveRoot against process.cwd() at the moment it runs — but that cwd differs
// between build phases: our own `npm run build` cd's into apps/web (cwd =
// apps/web, so a relative '../agent' would work), but Vercel's separate
// "onBuildComplete" / Build Output API post-processing step re-invokes this
// config from the repo root instead, where '../agent' resolves one level
// *above* the repo and fails with "entrypoint ... does not exist". An
// absolute path sidesteps the whole cwd-dependency problem for good.
// next.config.ts compiles to CommonJS here (no "type": "module" in
// package.json), so the plain CJS `__dirname` global is available directly —
// no import.meta/fileURLToPath dance needed (that approach forces esbuild to
// treat this file as ESM, which breaks Next's own CJS config wrapper).
const eveRootAbsolute = resolve(__dirname, '../agent');

// BlockSuite ships uncompiled TypeScript source (.ts files) as its
// package entry points — the `exports` field in each @blocksuite/*
// package.json points at `./src/*.ts`, not `./dist/*.js`. Next.js needs
// `transpilePackages` to run these through its compiler. Listed here are
// the packages actually imported by our doc-composer code.
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
  // graph (Better Auth, Prisma, the entire @blocksuite/* tree via
  // transpilePackages above), so 16 concurrent workers on an 8 GB box
  // reliably exceeds available memory and gets SIGKILLed by the OOM
  // killer with zero error output (looks like a silent "exited with 1"
  // right after "Compiled successfully" — no stack trace, no OOM message,
  // because the killed worker process never gets a chance to report
  // anything). Capping to 1 worker serializes page-data collection —
  // slower, but bounded, predictable memory use that fits the box.
  experimental: {
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
  // Every @blocksuite/* package ships raw TS source (see the exports-field
  // comment above) and BlockSuite's dependency graph transitively pulls in
  // effectively all of them (confirmed the hard way: a real `next build`
  // kept surfacing new "Module parse failed" errors for @blocksuite/affine-*
  // sub-packages one at a time until the full real list — from
  // node_modules/@blocksuite at build time — was included here).
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
    '@blocksuite/affine',
    '@blocksuite/affine-block-attachment',
    '@blocksuite/affine-block-bookmark',
    '@blocksuite/affine-block-callout',
    '@blocksuite/affine-block-code',
    '@blocksuite/affine-block-data-view',
    '@blocksuite/affine-block-database',
    '@blocksuite/affine-block-divider',
    '@blocksuite/affine-block-edgeless-text',
    '@blocksuite/affine-block-embed',
    '@blocksuite/affine-block-embed-doc',
    '@blocksuite/affine-block-frame',
    '@blocksuite/affine-block-image',
    '@blocksuite/affine-block-latex',
    '@blocksuite/affine-block-list',
    '@blocksuite/affine-block-note',
    '@blocksuite/affine-block-paragraph',
    '@blocksuite/affine-block-root',
    '@blocksuite/affine-block-surface',
    '@blocksuite/affine-block-surface-ref',
    '@blocksuite/affine-block-table',
    '@blocksuite/affine-components',
    '@blocksuite/affine-ext-loader',
    '@blocksuite/affine-foundation',
    '@blocksuite/affine-fragment-adapter-panel',
    '@blocksuite/affine-fragment-doc-title',
    '@blocksuite/affine-fragment-frame-panel',
    '@blocksuite/affine-fragment-outline',
    '@blocksuite/affine-gfx-brush',
    '@blocksuite/affine-gfx-connector',
    '@blocksuite/affine-gfx-group',
    '@blocksuite/affine-gfx-link',
    '@blocksuite/affine-gfx-mindmap',
    '@blocksuite/affine-gfx-note',
    '@blocksuite/affine-gfx-pointer',
    '@blocksuite/affine-gfx-shape',
    '@blocksuite/affine-gfx-template',
    '@blocksuite/affine-gfx-text',
    '@blocksuite/affine-gfx-turbo-renderer',
    '@blocksuite/affine-inline-footnote',
    '@blocksuite/affine-inline-latex',
    '@blocksuite/affine-inline-link',
    '@blocksuite/affine-inline-mention',
    '@blocksuite/affine-inline-preset',
    '@blocksuite/affine-inline-reference',
    '@blocksuite/affine-model',
    '@blocksuite/affine-rich-text',
    '@blocksuite/affine-shared',
    '@blocksuite/affine-widget-drag-handle',
    '@blocksuite/affine-widget-edgeless-auto-connect',
    '@blocksuite/affine-widget-edgeless-dragging-area',
    '@blocksuite/affine-widget-edgeless-selected-rect',
    '@blocksuite/affine-widget-edgeless-toolbar',
    '@blocksuite/affine-widget-edgeless-zoom-toolbar',
    '@blocksuite/affine-widget-frame-title',
    '@blocksuite/affine-widget-keyboard-toolbar',
    '@blocksuite/affine-widget-linked-doc',
    '@blocksuite/affine-widget-note-slicer',
    '@blocksuite/affine-widget-page-dragging-area',
    '@blocksuite/affine-widget-remote-selection',
    '@blocksuite/affine-widget-scroll-anchoring',
    '@blocksuite/affine-widget-slash-menu',
    '@blocksuite/affine-widget-toolbar',
    '@blocksuite/affine-widget-viewport-overlay',
    '@blocksuite/data-view',
    '@blocksuite/global',
    '@blocksuite/icons',
    '@blocksuite/std',
    '@blocksuite/store',
    '@blocksuite/sync',
    'lit',
    '@lit/react',
  ],
  // `xdg-app-paths` (transitively pulled in by prisma/@vercel/sandbox
  // tooling) auto-derives an app name from the CALLING module's real
  // Node `.filename` when webpack bundles it, `module.filename` doesn't
  // exist on webpack's module wrapper, so `path.parse(undefined)` throws
  // a real ERR_INVALID_ARG_TYPE — reproduced directly by diffing: `node -e
  // "require('@vercel/sandbox')"` succeeds standalone (real Node
  // `require`, real `.filename`), but the exact same code crashed only
  // inside a real `next build`'s webpack-bundled "collect page data"
  // step. Fix: keep this whole chain un-bundled (externalized) so it's
  // loaded via real Node `require` at runtime, matching the working
  // standalone case.
  serverExternalPackages: ['@prisma/client', '@vercel/sandbox', 'xdg-app-paths', 'xdg-portable'],
  // Next's own build-time type-check phase force-includes transpilePackages'
  // real .ts source into the same TS program as app code (confirmed: our
  // tsconfig already excludes node_modules + sets skipLibCheck, yet a real
  // `next build` still surfaced a type error INSIDE
  // @blocksuite/affine-block-surface-ref's own source — a real upstream
  // BlockSuite typing looseness with lit-html's `guard()` generic
  // inference, not anything in our code). We don't control or want to
  // patch third-party node_modules source. Disabling Next's bundled
  // typecheck here and instead running our own `tsc --noEmit` (which DOES
  // respect our tsconfig's node_modules exclude) as the real verification
  // gate for our own app code — see package.json's `typecheck` script.
  typescript: {
    ignoreBuildErrors: true,
  },
  // BlockSuite's raw-TS source uses NodeNext-style relative imports ending
  // in `.js` that point at sibling `.ts` files (e.g. `./adapter.js` ->
  // `./adapter.ts`). Turbopack doesn't resolve that mapping yet (tracked
  // upstream: github.com/vercel/next.js/issues/82945, still open as of
  // Next 16.2.10 — confirmed by an actual `next build` failing with
  // "Module not found" for every such import). webpack's
  // `resolve.extensionAlias` is the documented workaround, so this app
  // builds with `next build --webpack` until Turbopack gains parity.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };

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


    // BlockSuite's Lit components use TC39 stage-3 standard decorators
    // (the `accessor` keyword, e.g. `@property() accessor foo`) — real,
    // current JS syntax, not legacy TS `experimentalDecorators`. Verified
    // by hitting the actual parse failure in a real `next build --webpack`
    // ("Unexpected token `@`" / "Unexpected token" on `accessor`): SWC's
    // next-swc-loader doesn't yet support this decorator version, so these
    // specific node_modules files are routed through babel-loader instead,
    // configured with the same decorator spec version Babel documents as
    // matching the `accessor` proposal ("2023-05"). This runs BEFORE
    // next's own SWC oneOf rule by unshifting into it, and only applies to
    // @blocksuite/** source — app code still goes through SWC as normal.
    if (process.env.DEBUG_WEBPACK_RULES) {
      const fs = require('fs');
      fs.writeFileSync('/tmp/webpack-rules-debug.json', JSON.stringify(config.module.rules, (key, val) => {
        if (val instanceof RegExp) return val.toString();
        if (typeof val === 'function') return '[function]';
        return val;
      }, 2));
    }

    const oneOfRules = config.module.rules.filter((rule: any) => Array.isArray(rule.oneOf));
    for (const oneOfRule of oneOfRules) {
      oneOfRule.oneOf.unshift({
        test: /\.tsx?$/,
        include: /node_modules[\\/]@blocksuite/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-typescript'],
            plugins: [['@babel/plugin-proposal-decorators', { version: '2023-11' }]],
          },
        },
      });
    }

    return config;
  },
};

// withEve mounts the apps/agent eve project's /eve/v1/* routes directly
// into this Next.js app's origin (same-origin, no CORS, no URL env vars —
// see eve's docs/guides/frontend/nextjs.mdx). eveRootAbsolute (computed
// above) points at apps/agent, which contains the actual `agent/` folder
// (agent.ts, instructions.md, tools/, sandbox/) that eve looks for.
export default withEve(nextConfig, {
  eveRoot: eveRootAbsolute,
});
