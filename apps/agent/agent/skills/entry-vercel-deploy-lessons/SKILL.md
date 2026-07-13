---
description: "Entry-specific Vercel/monorepo deployment lessons learned the hard way on THIS project. Use whenever deploying Entry itself (not a user's generated app) to Vercel, debugging a failed Entry production build, or touching build/deploy scripts (build-vercel-output.sh, vercel.json, prisma migrate deploy). Triggers on 'deploy is failing', 'build broke', 'stale build', 'env var missing on Vercel', 'prisma migrate deploy error', 'withEve path error'."
metadata: {"author":"entry-team","version":"1.0.0"}
---
# Entry Vercel Deploy — hard-won lessons

Generic Vercel/Next.js skills (deploy-to-vercel, vercel-cli-with-tokens) are still correct and
should be followed for the mechanics. This skill only covers the traps specific to THIS repo's
monorepo layout that generic skills won't know about, each one a real incident, not a hypothetical.

## 1. Stale build cache can silently ship old code even after the source is fixed
If a fix "isn't showing up" in production despite the source clearly being correct, do NOT assume
the fix is wrong. First suspect the build cache: `rm -rf apps/web/.next .vercel/output` and do a
full clean rebuild before concluding anything. Verify the fix landed by grepping the actual output
chunk (`.vercel/output/functions/index.func/apps/web/.next/static/chunks/*.js`) for the expected
string — never trust "the build succeeded" alone as proof the right code shipped. After deploying,
re-verify against the LIVE URL too (`curl` the deployed chunk), not just the local build output —
these can differ if the wrong output directory got uploaded.

## 2. `DATABASE_URL` must be non-empty for local builds, even though Vercel injects the real one at runtime
`npm run build` runs `prisma generate` (and, unless `SKIP_PRODUCTION_MIGRATE_GUARD=1` is set,
`prisma migrate deploy`). Prisma's config loader errors with `Cannot resolve environment variable:
DATABASE_URL` if it is unset OR empty-string — and Neon's Vercel integration does not let
`vercel env pull` export the real production value locally (confirmed: comes back empty by
design). Fix: export a syntactically-valid placeholder (`postgresql://postgres:postgres@localhost:5432/entry_demo`,
already sitting in the repo's plain `.env`) before running a local build, and set
`SKIP_PRODUCTION_MIGRATE_GUARD=1` so the build doesn't also try to actually connect and migrate
against that placeholder. The real `DATABASE_URL` only needs to be correct in Vercel's actual
project env vars, which is a separate concern from what a local build needs to compile.

## 3. `withEve()` and other root-path resolution must use absolute paths, never `process.cwd()`-relative
Vercel's multi-stage build changes working directory between stages. Any helper that resolves a
path relative to `process.cwd()` (instead of `import.meta.url`/`__dirname`-derived absolute paths)
will work locally and break only on Vercel, non-deterministically depending on which stage runs it.
Always resolve monorepo root paths absolutely.

## 4. Use `./scripts/build-vercel-output.sh` then `vercel deploy --prebuilt --prod`, not `vercel build`
This repo assembles `.vercel/output` by hand (extracting the Next config blob, writing
`.vc-config.json` for the Lambda runtime, etc.) because of the monorepo output-directory routing —
`vercel build`'s own auto-detection does not route this correctly. Always run the repo's own build
script first, confirm `.vercel/output` was written, THEN `vercel deploy --prebuilt --prod --token
"$VERCEL_TOKEN"`. Never fall back to plain `vercel deploy` (without `--prebuilt`) as a shortcut —
it re-triggers Vercel's own build detection and reintroduces the exact routing problem this script
exists to avoid.

## 5. Headless Chrome in Vercel Sandbox needs its shared libs installed BEFORE `agent-browser install`
Vercel Sandbox's base image is minimal Debian with none of Chrome's required `.so` libraries
(`libnss3`, `libatk-bridge2.0-0`, `libgbm1`, `libasound2`, etc.). Chrome-for-Testing downloads fine
without them but fails to launch on every single run — indistinguishable from "the tool is broken"
from the outside. Always `apt-get install` the library list in `sandbox.ts`'s bootstrap BEFORE
installing agent-browser, and check `agent-browser install`'s exit code explicitly (a silent
failure here poisons the cached template for every future session).

## 6. Preview tunnels: prefer cloudflared quick tunnels over localtunnel
`loca.lt` (localtunnel's public relay) has no uptime guarantee and routinely fails to assign a
subdomain — this is an external reliability problem, not a bug in our code. `cloudflared`'s quick
tunnel (`trycloudflare.com`) needs no signup/token and is materially more reliable. Use it as the
primary path in `get_preview_url.ts`, falling back to localtunnel only if the cloudflared binary
itself can't be downloaded.

## 7. Always attribute commits to `Thirdbase1 <miraclethirdbase1@gmail.com>` and push after every real fix
Uncommitted local fixes are invisible to the next session and at risk of being lost entirely if the
sandbox resets. After any set of real code changes (not just at the end of a long session), run
`git add -A && git commit` with that identity and `git push origin main` — don't batch it up and
risk losing work.
