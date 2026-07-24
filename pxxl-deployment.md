# Pxxl Deployment Notes — Entry (thirdbase1/Entry)

Last updated: 2026-07-24 (corrected — earlier version of this file had the wrong account)

## THE correct account and project

- Account: **miraclethirdbase1@gmail.com**
- Project: **entry** — id `proj_ibab5ldta4l63qoentq7`
- Domain: **entry.pxxl.pro**
- This is a working, healthy, live deployment with multiple successful
  "deployed/completed" runs. Confirmed live 2026-07-24: `GET /` -> 200,
  `GET /api/health` -> `{"ok":true,"db":"connected"}`.
- All required env vars are already pushed to this project (DATABASE_URL,
  BETTER_AUTH_SECRET, BYOK_ENCRYPTION_KEY, CREDENTIAL_VAULT_KEY, GitHub
  OAuth creds, etc.) — check with `pxxl env list proj_ibab5ldta4l63qoentq7`
  before assuming something's missing.

To use this account in the sandbox, always run explicitly:
```bash
export PXXL_API_KEY="pxxl_6yvxGOg_fE0y2UQjtyty21sB_5BQmwy6pV88AAvRhbc"
unset PXXL_TOKEN
pxxl whoami   # should print miraclethirdbase1@gmail.com — confirm before anything else
```

## Do NOT use these — they are wrong accounts / dead ends

- The sandbox's default `$PXXL_TOKEN` / `$PXXL_API_KEY` env vars (present
  without you setting anything) resolve to **vwhehj@gmail.com**. That
  account also has a project confusingly also named `entry`
  (`proj_jja54nhxtknvzc31alcx`) but it has ONLY failed deployments — every
  attempt fails at Pxxl's "proxy route promotion" step even though the app
  starts and passes health check. Do not confuse this with the real
  project just because the name matches.
- The CLI's stored login session (`~/.config/pxxl/config.json`) resolves
  to **alfredjames0852@gmail.com** — an unrelated account with stray test
  projects (`oneshotsx-entry`, `entry-test-5/10/15`) created by mistake
  while chasing the wrong account on 2026-07-24. Ignore/leave these alone.
- **Always run `pxxl whoami` first** before any Pxxl command if there's
  any doubt which account/key is active — this single mistake (using the
  wrong account) wasted an entire session of retries on 2026-07-24.

## Gotchas discovered along the way (still valid, keep in mind for future deploys)

1. **`.pxxlignore` gets silently reset to Pxxl's hardcoded default after
   EVERY deploy** (`writeDefaultPxxlFiles` runs post-deploy and overwrites
   any custom ignore rules). Rewrite your custom `.pxxlignore` immediately
   before every single `pxxl deploy` call.
2. **~16MB hard cap on the CLI upload endpoint** — exceeding it returns a
   raw/unhelpful `502`. Binary-search the zip size if you hit a mystery 502.
3. **500-file cap** on the upload archive, separate from the byte-size cap.
   This is a monorepo (`apps/web` + `apps/agent` + `packages`); `apps/agent`
   alone is ~700 files if included wholesale.
4. **`apps/web` genuinely imports from `apps/agent`** via the `@entry/agent`
   workspace package — check `apps/agent/package.json`'s `exports` map
   before excluding anything. Only `agent/lib/**` (~58 files) is actually
   exported/used by `apps/web`. Safe to exclude: `apps/agent/.agents/**`,
   `apps/agent/agent/skills/**`, `apps/agent/agent/{tools,channels,hooks,
   sandbox,instructions}/**`, `apps/agent/evals/**`.
5. **A blanket `patches/` ignore rule can wipe out a required local
   dependency tarball** inside `apps/web/patches` needed by `patch-package`
   at `postinstall` — don't exclude `patches` wholesale.
6. **Large binary assets in `apps/web/public`** (e.g. a 26MB onboarding
   video) blow past size/file caps fast — host large media externally
   (e.g. Base44 public file storage) instead of bundling in the repo.
7. **Domains are globally unique across ALL Pxxl accounts**, not just
   per-account — a "domain already in use" error can mean a different
   account owns it, not necessarily you.
8. **The CLI's buildpack doesn't stream `npm run build`'s real output**
   into `pxxl logs` — you'll only see `npm install`/`postinstall` logs,
   then `[pxxl] build -> true` with nothing in between. This does NOT mean
   the build didn't run; verify by testing the live URL, not by looking
   for missing build logs.
9. Deploys to project `entry` (proj_ibab5ldta4l63qoentq7) happen via
   `pxxl deploy` CLI zip upload from a local working directory — this is
   independent of git. The "commit" shown in `pxxl deployments get` is a
   local snapshot label, not necessarily a real GitHub SHA. Still push to
   GitHub (thirdbase1/Entry, main) for history/durability and because
   Render deploys from git — just know the Pxxl deploy step itself doesn't
   require or trigger from a git push.

## Standard deploy procedure

```bash
# 1. Confirm the right account
export PXXL_API_KEY="pxxl_6yvxGOg_fE0y2UQjtyty21sB_5BQmwy6pV88AAvRhbc"
unset PXXL_TOKEN
pxxl whoami   # must say miraclethirdbase1@gmail.com

# 2. Work from a fresh clone/pull of thirdbase1/Entry
git pull origin main   # or fresh clone

# 3. Rewrite .pxxlignore fresh — it resets after every deploy, do this
#    immediately before every single deploy call, no exceptions
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

# 4. Deploy to the existing project (pxxl.toml should have
#    projectId = "proj_ibab5ldta4l63qoentq7" pinned)
pxxl deploy -m "<description>"

# 5. Poll until done
pxxl deployments recent
pxxl logs --deployment <dep_id>

# 6. Verify live — don't trust "Build completed successfully" alone
curl -sI https://entry.pxxl.pro/
curl -s https://entry.pxxl.pro/api/health
```
