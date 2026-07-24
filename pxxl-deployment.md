# Pxxl Deployment Notes — Entry (thirdbase1/Entry)

Last updated: 2026-07-24

## Current status: BLOCKED on Pxxl's own platform bug

Every single deploy attempt of this app on Pxxl — across TWO different
accounts (vwhehj@gmail.com project `entry` / `proj_jja54nhxtknvzc31alcx`,
and alfredjames0852@gmail.com project `oneshotsx-entry` /
`proj_pebeqy7m1noy6zo5jwq5`), on both 2026-07-21 and 2026-07-24 — gets all
the way through:
- Build completed successfully
- Application started successfully
- Health check passed - application is running

...and then fails at the very last step:
```
Promoting proxy route
Proxy route promotion delayed: application route did not become ready before timeout
Deployment was not activated because proxy route promotion failed
```
This happened on 10+ separate attempts, with different fixes tried (explicit
`0.0.0.0` bind, explicit port, fresh project, fresh domain). It is a Pxxl
platform-side issue, not an app bug — the container itself starts fine and
passes its own health check every time. Render remains the working
production host for entry.oneshotsx.cv (see
`.agents/rules/entry-git-commit-before-deploy.md`) while this is open.

Container limits on Pxxl's free/low tier are consistently `0.50 vCPU, 768MB
RAM` — worth trying again if/when the account is upgraded to a bigger plan,
in case the app just needs more headroom to become "ready" in time for the
proxy's own readiness probe (separate from our health check endpoint).

## CRITICAL: there are TWO Pxxl accounts in play — don't mix them up

- **vwhehj@gmail.com** — this is the account the sandbox has a live API
  token for by default, via env vars `$PXXL_TOKEN` / `$PXXL_API_KEY`
  (auto-injected by the platform's connected-secret system). This is the
  "real"/intended account. Do NOT `unset` these vars or run `pxxl login`
  with a different key unless you genuinely mean to switch accounts —
  doing so silently starts creating NEW projects on a DIFFERENT account,
  which is what caused a lot of confusion on 2026-07-24 (ended up with
  stray test projects `entry-test-5/10/15` on alfredjames0852@gmail.com
  that don't matter and can be ignored/left alone).
- Always run `pxxl whoami` first before doing anything if unsure which
  account is active.
- The project to deploy to is **`entry`** (`proj_jja54nhxtknvzc31alcx`)
  under vwhehj@gmail.com — NOT a new project.

## The full list of gotchas discovered (in the order they bite you)

1. **Env var override**: `$PXXL_TOKEN`/`$PXXL_API_KEY` in the sandbox
   silently pick the account for every `pxxl` command. Check `pxxl whoami`
   before assuming which account/project you're targeting.
2. **~16MB hard cap on the CLI upload endpoint**: exceeding it returns a
   raw/unhelpful `502`, not a clean error. Binary-search the zip size if
   you see a mystery 502 on deploy.
3. **`.pxxlignore` gets silently reset to Pxxl's hardcoded default on
   EVERY deploy** (`writeDefaultPxxlFiles` runs after each deploy and
   overwrites whatever custom ignore rules you had). You must rewrite your
   custom `.pxxlignore` immediately before every single `pxxl deploy`
   call — it will not persist between deploys.
4. **500-file cap** on the upload archive, separate from the byte-size
   cap. This repo is a monorepo (`apps/web` + `apps/agent` + `packages`),
   and `apps/agent` alone is ~700 files if included wholesale.
5. **`apps/web` genuinely imports from `apps/agent`** via the
   `@entry/agent` workspace package — do NOT blanket-exclude
   `apps/agent`, npm install will "succeed" quietly but the actual routes
   (e.g. `/api/direct/chat`) will break trying to resolve
   `@entry/agent/lib/*` at build/runtime.
   - Check `apps/agent/package.json`'s `exports` map — only
     `agent/lib/**` is actually exported/used by `apps/web`.
   - Safe to exclude from the deploy archive: `apps/agent/.agents/**`
     (unrelated dev-tooling/skills for the *agent's own* editor, ~300
     files), `apps/agent/agent/skills/**` (~300 files, the Trigger.dev
     worker's own runtime skills, not imported by web), and
     `apps/agent/agent/{tools,channels,hooks,sandbox,instructions}/**`,
     `apps/agent/evals/**`. Keep `apps/agent/package.json` and
     `apps/agent/agent/lib/**` (only ~58 files).
6. **A blanket `patches/` ignore rule can wipe out a required local
   dependency tarball/patch** living inside `apps/web/patches` — don't
   exclude `patches` wholesale if `patch-package` needs those files at
   `postinstall`.
7. **Large binary assets in `apps/web/public`** (e.g. a 26MB onboarding
   video) blow past the size/file caps fast. Host large media externally
   (we used Base44's public file storage) and point the `<video>`/`<img>`
   src at the external URL instead of bundling it in the repo/public dir.
8. **Domains are globally unique across ALL Pxxl accounts**, not just
   per-account. `--domain` clashing with "Domain is already in use" can
   mean a DIFFERENT account already grabbed that name, not that you own it.
9. **The CLI's auto-detected buildpack does not stream `npm run build`'s
   real output** into `pxxl logs` — you'll only see `npm install` /
   `postinstall` logs, then `[pxxl] build -> true` with no visible
   Next.js/Prisma build output in between. This is just how their log
   capture works; it does NOT mean the build didn't run. Confirmed by
   testing the live URL directly after a "Build completed successfully"
   status — don't waste time trying to find missing build logs.
10. Use a `pxxl.toml` with an explicit `projectId`, `buildCommand`
    (`npm run build` — must match the *actual* root `package.json` build
    script, which runs `db:deploy` (prisma migrate) then
    `next build --webpack` in `apps/web`), and `startCommand` to avoid
    relying on buildpack auto-detection guessing wrong.

## Correct procedure once the proxy-promotion bug is fixed/resolved

```bash
# 1. ALWAYS confirm which account is active first
pxxl whoami

# 2. Work from a fresh clone/pull of thirdbase1/Entry
git pull origin main   # or fresh clone

# 3. Rewrite .pxxlignore fresh — it gets reset after every deploy, so do
#    this step immediately before every single deploy, no exceptions.
cat > .pxxlignore << 'EOF'
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
.next
.next/**
.turbo
.turbo/**
.cache
.cache/**
.config/pxxl
.config/pxxl/**
.pxxlignore
pxxl-source.zip
apps/agent/.agents
apps/agent/.agents/**
apps/agent/agent/skills
apps/agent/agent/skills/**
apps/agent/agent/tools
apps/agent/agent/tools/**
apps/agent/agent/channels
apps/agent/agent/channels/**
apps/agent/agent/hooks
apps/agent/agent/hooks/**
apps/agent/agent/sandbox
apps/agent/agent/sandbox/**
apps/agent/agent/instructions
apps/agent/agent/instructions/**
apps/agent/evals
apps/agent/evals/**
apps/agent/skills-lock.json
apps/agent/safety-net.cjs
apps/agent/DEPLOY.md
docs
docs/**
.github
.github/**
admin.md
BYOK_ARCHITECTURE.md
README.md
DEPLOY.md
vercel.json
skills-lock.json
Dockerfile.agent
EOF

# 4. pxxl.toml should already have projectId = "proj_jja54nhxtknvzc31alcx"
#    pinned so this always redeploys the SAME project, not a new one.

# 5. Push/replace env vars for this project (build-time NEXT_PUBLIC_* vars
#    need to be present BEFORE the deploy that bakes them in)
pxxl env push --force --file .env.production proj_jja54nhxtknvzc31alcx

# 6. Deploy
pxxl deploy -m "<description>"

# 7. Poll until done
pxxl deployments recent
pxxl logs --deployment <dep_id>

# 8. Verify live, don't trust "Build completed successfully" alone —
#    that only means the image built, not that the proxy route is live.
curl -sI https://<domain>/api/health
```

## Open item / next step
Pxxl support should be contacted about the reproducible
"Proxy route promotion delayed: application route did not become ready
before timeout" failure — it happens on a brand-new empty test project too
(not just this repo), suggesting it may be an account/plan-tier issue
rather than anything specific to the Entry app. Until resolved, Render
stays primary.
