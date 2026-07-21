import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_vgvlsxmgwymoztumjouy",
  runtime: "node",
  logLevel: "log",
  // The max compute seconds a task is allowed to run. If the task run exceeds this duration, it will be stopped.
  // You can override this on an individual task.
  // See https://trigger.dev/docs/runs/max-duration
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  build: {
    // browser_use.ts (one of the 22 tools agent-turn.ts wires) type-imports
    // playwright-core, which transitively requires chromium-bidi's CJS
    // subpath exports at runtime -- esbuild can't statically resolve those
    // (2026-07-21, real build failure: "Could not resolve
    // chromium-bidi/lib/cjs/bidiMapper/BidiMapper"). Both are already
    // native/runtime-resolved in the Next.js build (see next.config.ts's
    // serverExternalPackages comment for the same class of issue) --
    // external here for the same reason: load via real Node `require` at
    // runtime instead of trying to statically bundle them.
    external: ["playwright-core", "chromium-bidi"],
  },
  dirs: ["./src/trigger"],
});
