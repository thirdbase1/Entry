# Deploying the Entry agent worker to Pxxl

This documents how to deploy `apps/agent` (the standalone agent worker) to
Pxxl, and every real gotcha discovered doing it. Read the "Known platform
bug" section before you spend hours re-discovering it.

## Current state (as of 2026-07-20)

- Working project: `entry-agent-worker-v4` (`proj_eu2cuj0efa3s7xks0dhl`),
  live URL `https://entry-agent-worker-v4.pxxl.run`.
- Its **first** deploy (a tiny throwaway stub) went live cleanly and is
  still the only deployment actually serving traffic on that domain.
- Every deploy of the **real** worker code since then has failed at the
  "promote new proxy route" step -- see below. The stub is still what
  answers requests on that domain right now.
- An older project, `entry-agent-worker-v2` (`proj_g74qdbh2hb7anunudlqs`),
  hit the identical failure on 5 separate redeploy attempts.

## Known platform bug: rollover promotion hangs and times out

**Symptom:** deploy build succeeds, app container starts, Pxxl's own
health check passes within ~2 seconds -- but then:
```
Starting Graceful Rollover
Previous deployment detected
Promoting proxy route
Promoting proxy route   (repeats every ~10s)
...
Proxy route promotion delayed: application route did not become ready before timeout
Deployment was not activated because proxy route promotion failed
```
~70-90 seconds after container start, the deployment is marked `failed`,
and the **previous** deployment keeps serving traffic (fails safe, but
your new code never goes live).

**What we ruled out** (confirmed across ~8 attempts on 2 different
projects, 2 different physical build/runtime hosts):
- Not our app code -- happened before and after fixing a real build-time
  crash (see below) and a real startup-blocking network call, with
  identical ~70s timing every time.
- Not archive size / `.pxxlignore` -- happened on both a 1.7MB trimmed
  archive and (accidentally) a 75MB untrimmed one.
- Not a stuck/corrupted domain -- happened on a **brand-new** project's
  domain on its first *real* deploy (its throwaway stub deploy to the
  same domain, seconds earlier, activated instantly with no rollover
  step, since there was no previous deployment to roll over from).

**Pattern:** it only ever happens when Pxxl detects a *previous*
deployment already live on the project ("Previous deployment detected"
-> graceful rollover). A project's very first deploy (nothing to roll
over from) has consistently gone live immediately, every time we tried it.

**Conclusion:** this looks like a bug in Pxxl's blue-green rollover /
proxy-route-promotion logic specifically, not anything in this repo's
control. If you hit this:
1. Don't burn time re-diagnosing the app -- check `pxxl logs --deployment
   <id>` for the exact same three lines above. If you see them, it's this
   bug, not your code.
2. The safe fallback is: the previous deployment keeps serving, so
   production traffic isn't down -- but your new code isn't live either.
3. Contact Pxxl support with the failing deployment ID(s) and this
   pattern description. Mention it reproduces on brand-new projects too
   (rules out account/domain-specific corruption).
4. If you need to get *unblocked* short-term: create a brand-new Pxxl
   project (new name -> new subdomain), since a project's first deploy
   reliably works. You'll need to re-point whatever consumes the worker's
   URL (env vars, DNS, etc.) at the new subdomain each time. This is a
   workaround, not a fix -- the next redeploy to *that* project will likely
   hit the same wall once it, too, has a previous deployment to roll
   over from.

## Gotcha #1: `.pxxlignore` gets reset by the CLI on every `pxxl deploy`

`pxxl deploy` silently rewrites `.pxxlignore` back to its own minimal
default (10 base patterns) as a side effect of running -- **every single
call**, regardless of whether the project is new or already exists. If
you don't notice, your next deploy silently re-includes everything you'd
trimmed (in this repo that's the difference between a 1.7MB archive and a
75MB one -- `apps/web`, `.eve`, `.output`, `.vercel`, dev-tooling skill
scaffolds, etc.).

**Rule: rewrite `.pxxlignore` to its full trimmed contents immediately
before every single `pxxl deploy` call, not just once.** Don't rely on it
staying committed/on-disk from a previous run.

Current trimmed contents (adjust paths if this monorepo's layout changes):
```
.git
.git/**
node_modules
node_modules/**
.env
.env.*
*.log
dist
dist/**
build
build/**
.turbo
.turbo/**
.cache
.cache/**
.config/pxxl
.config/pxxl/**
.pxxlignore
pxxl-source.zip
.eve
.eve/**
.output
.output/**
.vercel
.vercel/**
apps/web
apps/web/**
apps/agent/.agents
apps/agent/.agents/**
apps/agent/agent/skills
apps/agent/agent/skills/**
*.tsbuildinfo
```

Verify the archive size in the deploy output (`Created Pxxl deploy
archive (N bytes...)`) -- it should be roughly 1.5-2MB for this repo. If
it's 70MB+, `.pxxlignore` got reset; stop, rewrite it, redeploy.

## Gotcha #2: build runs on a different machine than runtime, with no env vars

Pxxl builds on a "buildserver" machine and runs the container on a
separate "spaceship"/runtime machine. **Env vars pushed via `pxxl env
push` are only injected into the runtime container -- the build step never
sees them**, even for an already-existing project with vars already
pushed.

This broke `npm install`'s postinstall step, which runs `prisma generate`.
Prisma's own `env()` config helper throws **eagerly and unconditionally**
if the named var is unset:
```
PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.
npm error command failed
```
Fix applied in `packages/db/prisma.config.ts`: `prisma generate` never
opens a real DB connection (it only reads `schema.prisma`), so it's safe
to fall back to a syntactically-valid placeholder URL when the real var
isn't present (build time), while still using the genuine value whenever
it is present (runtime, and on hosts like Vercel where the build step
does get real env vars). `migrate deploy` and all real queries only ever
run at runtime, where the genuine value is always injected on every host
this app deploys to.

**Rule:** any build-time step (postinstall scripts, codegen, etc.) that
reads `process.env.X` must tolerate `X` being completely absent on Pxxl,
even if you've pushed it and it's visible in `pxxl env list`.

## Gotcha #3: don't let any top-level `await` risk blocking startup

`apps/agent/agent/agent.ts` resolves its default model id via a top-level
`await resolveModelIdForProvider('anthropic')` at module-eval time (see
`lib/model-catalog.ts`) -- meaning that fetch has to finish before the
process can even bind its HTTP port, on **any** host. We don't have
confirmed proof this specific call caused a Pxxl deploy failure (the
rollover bug above reproduced even after fixing this), but it's exactly
the kind of thing that silently turns "app is slow to start on this host"
into "app never becomes routable, ever." Fixed defensively: the catalog
fetch now has a 4s abort timeout and a static per-provider fallback model
id, so module eval always completes quickly regardless of network
conditions on whatever host it runs on.

**Rule:** any network call awaited at module top-level (not inside a
request handler) is a startup-availability risk on every host you might
ever deploy to. Bound it with a timeout and a safe fallback.

## Step-by-step: CLI deploy (zip-upload, what this repo currently uses)

This project ended up on Pxxl's internal "spacedrop" (CLI zip-upload)
project type rather than a GitHub-linked one, because the original
project name collided with an existing project during initial setup and
the CLI silently fell back to this flow. If you're setting up a *new*
project, prefer the GitHub-linked flow below instead -- it avoids Gotcha
#1 entirely, since Pxxl builds straight from your repo and there's no
local `.pxxlignore` to reset.

1. From the repo root (`/tmp/entry_work` or wherever you've checked it
   out), confirm/set `pxxl.toml`:
   ```toml
   name = "entry-agent-worker-v4"
   framework = "node"
   packageManager = "npm"
   installCommand = "npm install"
   buildCommand = "npm run build --workspace=apps/agent"
   startCommand = "npm run start --workspace=apps/agent -- --host 0.0.0.0"
   port = 3000
   domainChoice = "pxxl.run"
   projectId = "proj_eu2cuj0efa3s7xks0dhl"   # omit entirely to create a new project
   ```
2. Push env vars (build them into a scratch file first so you only push
   what the worker actually needs, not every secret in `.env.production.local`):
   ```bash
   for k in DATABASE_URL DATABASE_URL_UNPOOLED CREDENTIAL_VAULT_KEY \
            BYOK_ENCRYPTION_KEY EVE_INTERNAL_JWT_SECRET BLOB_READ_WRITE_TOKEN \
            ADMIN_DEBUG_TOKEN NODE_ENV; do
     grep "^${k}=" .env.production.local
   done > .env.pxxl_worker
   echo 'WORKFLOW_TARGET_WORLD=@workflow/world-postgres' >> .env.pxxl_worker
   echo 'WORKFLOW_POSTGRES_JOB_PREFIX=entry-agent-v4' >> .env.pxxl_worker
   echo 'ENTRY_WEB_ORIGIN=https://entry.oneshotsx.cv' >> .env.pxxl_worker
   cp .env.pxxl_worker .env.push_tmp
   pxxl env push proj_eu2cuj0efa3s7xks0dhl --force --file .env.push_tmp
   rm -f .env.push_tmp .env.pxxl_worker
   ```
3. **Rewrite `.pxxlignore`** to the full trimmed contents above -- every
   time, right before the next command.
4. Deploy:
   ```bash
   pxxl deploy -m "describe what changed"
   ```
   Check the printed archive size immediately -- should be ~1.5-2MB, not
   70MB+.
5. Poll status:
   ```bash
   pxxl deployments list --project proj_eu2cuj0efa3s7xks0dhl
   pxxl logs --deployment <deployment-id> --since 30m
   ```
   Watch for the rollover-bug failure signature above. If build itself
   fails, the logs will show the actual `npm install`/build error instead.
6. Verify it's really the new code (not a stale previous deployment still
   serving) by checking response content, not just HTTP status:
   ```bash
   curl -sS https://entry-agent-worker-v4.pxxl.run/
   ```

## Step-by-step: GitHub-linked deploy (recommended for any new project)

Do this from the Pxxl dashboard (`https://pxxl.app`), not the CLI, so
Pxxl builds directly from the repo and there's no local `.pxxlignore` to
manage or reset:

1. Push all code to `github.com/thirdbase1/Entry` first (branch
   `pxxl-migration-worker-standalone`, or `main` once merged) -- see the
   repo's own `DEPLOY.md` and the "Entry project -- always commit + push
   to GitHub" standing rule. Pxxl deploys whatever's actually on GitHub,
   nothing local.
2. In the Pxxl dashboard: **New Project -> Import from GitHub**, authorize
   the GitHub App if prompted, and select `thirdbase1/Entry`.
3. Set the project root / monorepo subdirectory to `apps/agent` if the
   dashboard supports a root-directory field, OR keep the repo root and
   set build/start commands exactly as in `pxxl.toml` above
   (`npm run build --workspace=apps/agent`, `npm run start
   --workspace=apps/agent -- --host 0.0.0.0`, port `3000`).
4. Add a `.pxxlignore` at the repo root (committed to git this time, so
   it can't be silently reset the way the CLI flow resets an
   uncommitted one) with the trimmed contents above -- this keeps
   Pxxl's own build context small and fast.
5. In the dashboard's Environment Variables section, add exactly the
   vars listed in step 2 of the CLI flow above (same names/values).
6. Trigger the first deploy. Because this is a brand-new project, it
   should go live immediately (no previous deployment to roll over from --
   see the rollover bug above). Every *subsequent* push-triggered
   redeploy is where you need to watch for that bug; if it hits, the
   previous deployment stays live/serving while you escalate to Pxxl
   support.
7. Every future push to the connected branch triggers a redeploy
   automatically -- no CLI needed at all going forward.

## Quick reference: what's proven to work vs. not

| Step | Status |
|---|---|
| Build succeeds locally (`npm run build --workspace=apps/agent`) | works |
| `prisma generate` at build time with no `DATABASE_URL` | fixed, works |
| Server binds + responds locally in <10ms | works |
| Brand-new Pxxl project's first deploy | works, goes live immediately |
| Any subsequent deploy needing rollover from a previous deployment | fails ~70-90s in, every time (Pxxl-side bug) |
| Custom domain on Pxxl (beyond the free `*.pxxl.run` subdomain) | blocked separately by this account's custom-domain limit |
