# Pxxl Deployment Notes — Entry (thirdbase1/Entry)

Last updated: 2026-08-02 (account correction pending — see notice below)

## ACCOUNT CORRECTION (2026-08-02)

The owner has corrected this: the actual Pxxl login/deploy account is
**the Pxxl account (see sandbox rule file)**. Earlier notes in this doc calling that account
"dead" were wrong. Project ID / production URL under this account are
being re-confirmed — do not assume `proj_ibab5ldta4l63qoentq7` or
`entry.pxxl.pro` still apply until re-verified with `pxxl whoami` /
`pxxl projects list` while logged into the Pxxl account (see sandbox rule file).

Never embed a literal API key value in this file (or any repo file) —
reference the sandbox rule file instead. A key was previously leaked this
way via old commits to this exact file; treat any key ever committed here
as burned.

## Current status: needs re-verification under the corrected account

Production for this app runs on **Pxxl**. Pxxl is the only deploy target —
there is no other platform in the loop.

### The one real platform bug, and its fix

Pxxl has a proxy-promotion step with a strict readiness timeout. A plain
`next start` boots too slowly and misses it — the deploy builds, starts,
passes its own health check, then fails at the very last step with:
```
Proxy route promotion delayed: application route did not become ready before timeout
Deployment was not activated because proxy route promotion failed
```
**The fix**: build with Next.js **standalone** output and start THAT
server directly instead of `next start` — it boots fast enough to
consistently beat the timeout. This is why `pxxl.toml`'s
`buildCommand`/`startCommand` look the way they do below.

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
   first — it should say `the Pxxl account (see sandbox rule file)`. If not:
   `pxxl login --api-key <key from .agents rule>`.
2. **~16MB hard cap on the CLI upload endpoint**: exceeding it returns a
   raw/unhelpful `502`, not a clean error. Binary-search the zip size if
   you see a mystery 502 on deploy.
3. **`.pxxlignore` gets silently reset to Pxxl's hardcoded default on
   EVERY deploy** — rewrite it fresh immediately before every single
   `pxxl deploy` call, it will not persist between deploys. (This has
   caused a real failed deploy before — a deploy that got interrupted
   mid-run left `.pxxlignore` reset to the default, and the *next* deploy
   call reused that stale reset file instead of a fresh one, blowing past
   the 500-file cap below.)
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
11. `pxxl deploy` can take well over a minute (sometimes 2+) to move from
    `building` to `deployed` — poll patiently, don't give up early.

## The correct procedure (current, working)

```bash
pxxl whoami   # confirm the Pxxl account (see sandbox rule file)

git pull origin main

# Rewrite .pxxlignore fresh -- it does NOT persist between deploys (see
# gotcha #3 above). Do this immediately before every single deploy call.
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

`ANCHORBROWSER_API_KEY` was added 2026-07-24 for the Anchor Browser
lane — 57 vars total as of this writing.

## GitHub-connected deploy settings (paste into Pxxl dashboard)

If connecting this repo to Pxxl via GitHub (auto-deploy on push to `main`)
instead of the manual `pxxl deploy` CLI, use these exact settings in the
project's Git/Build settings on the Pxxl dashboard:

- **Repository:** thirdbase1/Entry
- **Branch:** main
- **Root directory:** (repo root — leave blank/`.`)
- **Framework:** Next.js
- **Package manager:** npm
- **Install command:**
  ```
  npm install
  ```
- **Build command:**
  ```
  SKIP_PRODUCTION_MIGRATE_GUARD=1 npm run build && mkdir -p apps/web/.next/standalone/apps/web/.next && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static && cp -r apps/web/public apps/web/.next/standalone/apps/web/public
  ```
- **Start command:**
  ```
  node apps/web/.next/standalone/apps/web/server.js
  ```
- **Port:** 3000
- **Project ID:** proj_ibab5ldta4l63qoentq7

These are identical to the `pxxl.toml` values above — the standalone-build
trick is what beats Pxxl's proxy-promotion readiness timeout, and that's
true whether the deploy is triggered by the CLI or by a GitHub push. Env
vars are already set on this project (see below) so a GitHub-triggered
deploy should pick them up without re-entering anything.
