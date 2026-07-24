# Pxxl Deployment Notes — Entry (thirdbase1/Entry)

Last updated: 2026-07-24

## Current status: LIVE and working

As of 2026-07-24, production deployment for this app runs on **Pxxl**
(Render is the former platform — still technically running but no longer
the deploy target; see `.agents/rules/entry-git-commit-before-deploy.md`
in the agent's own sandbox for the full standing rule).

- **Account:** miraclethirdbase1@gmail.com
- **Project:** `entry` (`proj_ibab5ldta4l63qoentq7`)
- **Live URL:** https://entry.pxxl.pro
- Verified healthy: `curl https://entry.pxxl.pro/api/health` returns
  `{"ok":true,"db":"connected"}`.

Earlier attempts on two OTHER accounts (`vwhehj@gmail.com` project `entry`
/ `proj_jja54nhxtknvzc31alcx`, and `alfredjames0852@gmail.com` project
`oneshotsx-entry` / `proj_pebeqy7m1noy6zo5jwq5`) hit a real Pxxl platform
bug — the deploy would build, start, and pass its own health check, then
fail at the very last step with:
```
Proxy route promotion delayed: application route did not become ready before timeout
Deployment was not activated because proxy route promotion failed
```
**The fix that resolved this**: build with Next.js **standalone** output
and start THAT server directly instead of `next start` — it boots fast
enough to consistently beat Pxxl's proxy-promotion readiness timeout. This
is why `pxxl.toml`'s `buildCommand`/`startCommand` look the way they do
below. Those two older accounts/projects are now dead — ignore any
reference to them elsewhere. The `entry-test` project
(`proj_9lbp7pee8ws99546u4ov`) was a one-off validation deploy only, also
safe to ignore.

## `pxxl.toml` (current, working)

```toml
name = "entry"
framework = "nextjs"
packageManager = "npm"
installCommand = "npm install"
buildCommand = "SKIP_PRODUCTION_MIGRATE_GUARD=1 npm run build && mkdir -p apps/web/.next/standalone/apps/web/.next && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static && cp -r apps/web/public apps/web/.next/standalone/apps/web/public"
startCommand = "node apps/web/.next/standalone/apps/web/server.js"
port = 3000
projectId = "proj_ibab5ldta4l63qoentq7"
```

## Gotchas discovered (in the order they bite you)

1. **Env var override**: `$PXXL_TOKEN`/`$PXXL_API_KEY` in the sandbox may
   point at a different account than intended. Always run `pxxl whoami`
   first — it should say `miraclethirdbase1@gmail.com`. If not:
   `pxxl login --api-key <key from .agents rule>`.
2. **~16MB hard cap on the CLI upload endpoint**: exceeding it returns a
   raw/unhelpful `502`, not a clean error. Binary-search the zip size if
   you see a mystery 502 on deploy.
3. **`.pxxlignore` gets silently reset to Pxxl's hardcoded default on
   EVERY deploy** — rewrite it fresh immediately before every single
   `pxxl deploy` call, it will not persist between deploys.
4. **500-file cap** on the upload archive, separate from the byte-size
   cap. This repo is a monorepo (`apps/web` + `apps/agent` + `packages`),
   and `apps/agent` alone is ~700 files if included wholesale.
5. **`apps/web` genuinely imports from `apps/agent`** via the
   `@entry/agent` workspace package — do NOT blanket-exclude
   `apps/agent`, npm install will "succeed" quietly but real routes will
   break resolving `@entry/agent/lib/*` at build/runtime.
   - Only `agent/lib/**` is actually exported/used by `apps/web`.
   - Safe to exclude: `apps/agent/.agents/**`, `apps/agent/agent/skills/**`,
     `apps/agent/agent/{tools,channels,hooks,sandbox,instructions}/**`,
     `apps/agent/evals/**`. Keep `apps/agent/package.json` and
     `apps/agent/agent/lib/**`.
6. **A blanket `patches/` ignore rule can wipe out a required local
   dependency tarball/patch** — don't exclude `patches` wholesale.
7. **Large binary assets in `apps/web/public`** blow past size/file caps
   fast — host large media externally instead.
8. **Domains are globally unique across ALL Pxxl accounts**, not just
   per-account.
9. **The CLI's auto-detected buildpack does not stream `npm run build`'s
   real output** into `pxxl logs` — this is normal, not a sign of failure.
10. Use a `pxxl.toml` with explicit `projectId`, `buildCommand`, and
    `startCommand` to avoid buildpack auto-detection guessing wrong.
11. `pxxl deploy` can take well over a minute to move from `building` to
    `deployed` — poll patiently.

## The correct procedure (current, working)

```bash
pxxl whoami   # confirm miraclethirdbase1@gmail.com

git pull origin main

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
EOF

export PXXL_API_KEY="<key from .agents rule>"
export PXXL_TOKEN="$PXXL_API_KEY"
pxxl deploy -m "<real description>"

pxxl deployments get <deployment_id>   # wait for Status: deployed, Build: completed
curl -s https://entry.pxxl.pro/api/health   # expect {"ok":true,"db":"connected"}
```

## Env vars on the production project

All required production env vars are already correctly set on
`proj_ibab5ldta4l63qoentq7` — confirmed via
`pxxl env list proj_ibab5ldta4l63qoentq7`. Don't re-push blind; only touch
a specific key if something is actually confirmed missing/wrong.
