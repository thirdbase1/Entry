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

## Why the successful deploys worked (and the broken ones didn't) — root cause

All Pxxl deploys go through the same last step: after the container passes
its own health check, Pxxl "Promotes the proxy route" — this has a tight
~15-20s window. On the 5 successful `entry` deploys, this step consistently
finished in ~13-14s. On every failed attempt (both the 2 failures on this
same project, and all attempts on the wrong `vwhehj@gmail.com` project),
it missed that window and timed out. Root cause: the successful deploys
start the app via Next.js **standalone output mode**
(`node apps/web/.next/standalone/apps/web/server.js`), which boots far
faster than `next start` (skips full node_modules/workspace resolution).
The failed attempts used `next start` directly, which is slow enough to
usually blow past Pxxl's promotion timeout.

**Lesson: always start from standalone output on Pxxl, never `next start`.**
`next.config` already has `output: 'standalone'` set repo-wide (used by
Render too), so this just means using the right startCommand:

```
buildCommand = "SKIP_PRODUCTION_MIGRATE_GUARD=1 npm run build && mkdir -p apps/web/.next/standalone/apps/web/.next && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static && cp -r apps/web/public apps/web/.next/standalone/apps/web/public"
startCommand = "node apps/web/.next/standalone/apps/web/server.js"
```

`SKIP_PRODUCTION_MIGRATE_GUARD=1` skips `prisma migrate deploy` at build
time — Render already owns migrations against the same shared Neon DB, so
this avoids a double-migrate race between the two hosts. If a new Prisma
migration folder is ever added, apply it manually once via
`POST /api/admin/db/migrate` after that specific deploy.

Even with the standalone server, the promotion step is NOT 100%
deterministic (2 of 7 deploys on the correct project still failed) — it's
inherently a bit flaky on Pxxl's side. If a deploy fails at "Proxy route
promotion delayed", just retry `pxxl deploy` again as-is; it's a transient
race, not a config problem, as long as startCommand uses the standalone
server.

## Pulling authoritative env vars from Render (2026-07-24)

When standing up a brand-new Pxxl project/test deploy, Render is the
source of truth for env vars (it's the primary confirmed-stable
production host). Pull directly via Render's API rather than retyping
values by hand:

```bash
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services/srv-d9f70md7vvec73fp4g30/env-vars?limit=100" \
  -o /tmp/render_env.json

python3 -c "
import json
with open('/tmp/render_env.json') as f:
    d = json.load(f)
lines = []
for item in d:
    k = item['envVar']['key']
    v = item['envVar'].get('value', '')
    v_escaped = v.replace('\"', '\\\\\"')
    lines.append(f'{k}=\"{v_escaped}\"')
with open('.env.render', 'w') as out:
    out.write('\n'.join(lines) + '\n')
"
```

This pulled **35 env vars** from Render on 2026-07-24 (confirmed working
set, all needed for the app to run): `VERCEL_OAUTH_CLIENT_SECRET`,
`VERCEL_OAUTH_CLIENT_ID`, `NEXT_PUBLIC_APP_URL`, `GITHUB_OAUTH_CLIENT_SECRET`,
`GITHUB_OAUTH_CLIENT_ID`, `E2B_API_KEY`, `EVE_INTERNAL_JWT_SECRET`,
`BETTER_AUTH_SECRET`, `HOSTNAME`, `NODE_ENV`, `DATABASE_URL`,
`CREDENTIAL_VAULT_KEY`, `CHAT_IMMEDIATE_BACKGROUND`, `BYOK_ENCRYPTION_KEY`,
`BLOB_READ_WRITE_TOKEN`, `AI_GATEWAY_API_KEY`, `ADMIN_DEBUG_TOKEN`,
`TRIGGER_SECRET_KEY`, `PARALLEL_API_KEY`, `STEEL_API_KEY`,
`GOOGLE_CLIENT_ID`, `BROWSER_USE_API_KEY`, `LAMCH_API_KEY`,
`DATABASE_URL_UNPOOLED`, `KV_REST_API_READ_ONLY_TOKEN`,
`KV_REST_API_TOKEN`, `KV_REST_API_URL`, `KV_URL`, `REDIS_URL`,
`SENDBYTE_FROM_DOMAIN`, `SENDBYTE_API_KEY`, `GOOGLE_CLIENT_SECRET`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `BRIGHTDATA_CDP_URL`.

Before pushing this set to a NEW Pxxl project/domain, always override
`NEXT_PUBLIC_APP_URL` to that project's own domain first — otherwise
OAuth redirects, CORS/allowedHosts checks, and absolute link generation
will silently point at the wrong (production) domain:

```bash
sed -i 's|NEXT_PUBLIC_APP_URL=.*|NEXT_PUBLIC_APP_URL="https://<new-domain>"|' .env.render
pxxl env push --force .env.render <project-id>
pxxl redeploy <project-id>   # env vars only take effect after a redeploy/restart
```

## "DB unreachable" on a brand-new deploy — false alarm, not a Neon block

On the first `entry-test` deploy (2026-07-24), `/api/health` reported
`db: "unreachable"` consistently across ~6 checks over ~40s, even though
the exact same `DATABASE_URL` was reporting `connected` on the main
`entry` production project at the same time. This looked exactly like a
Neon IP-allowlist block (different Pxxl account/project → different
egress IP → not on an allowlist) and was initially treated as one.

**It wasn't.** After pushing the full 35-var Render-sourced env (vs. an
earlier incomplete 17-var push) and redeploying, the FIRST health check
after the new container started still showed `unreachable`, but the very
next check ~15s later showed `connected`, and it has stayed `connected`
on every check since. Root cause: `/api/health`'s DB probe
(`apps/web/app/api/health/route.ts`) uses a hard **2-second** timeout
(`DB_PROBE_TIMEOUT_MS = 2_000`) specifically so a slow DB never blocks
the liveness response Render/Pxxl's health checker needs instantly. A
brand-new container's very first Postgres connection has to do a fresh
TLS handshake plus Neon's `channel_binding=require` negotiation, which
occasionally exceeds 2s — the main project's health checks look instant
because its process has had a live/warm connection pool for hours.

**No Neon IP allowlist change was made or needed.** If `db: unreachable`
shows up on a fresh deploy, retry a few times over ~30-60s before
assuming a network/credentials problem — it's very likely just the
same first-connection cold start, not a real block.

## Root cause note: why Redis is conditional, not missing (carried over from BYOK work)

Direct quote, worth keeping verbatim since it explains a design decision
that might otherwise look like a bug (`REDIS_URL` present in env but the
app not requiring it to boot):

> No Redis instance exists anywhere in this infra — it was only ever
> needed to fix Vercel's stateless serverless problem. Since we're now on
> a persistent server (Pxxl/Render), in-memory rate limiting works fine
> within one process. Making it conditional instead of provisioning
> unnecessary infra.

Practically: Better Auth's `secondaryStorage` (used for rate limiting) is
wired to only initialize against Redis if a real `REDIS_URL` is present
and valid; otherwise it falls back to in-memory state. This is safe on
Pxxl/Render specifically because both are long-running single processes,
not cold-starting serverless functions — in-memory state persists across
requests the way it never could on Vercel. Do not "fix" this by
provisioning a Redis/Upstash instance unless the app moves to a
multi-instance or serverless deployment model again, where in-memory
state would stop being shared correctly.

## Correction (2026-07-24, same day): the "full 35-var push" wasn't actually full

The section above describing the Render env pull was written right after
running `pxxl env push --force .env.render <project-id>` — but that
command is wrong. **`pxxl env push` does not accept a custom filename
argument.** Per `pxxl env --help`, the real syntax is:

```
pxxl env push [project-id]
pxxl env push --force [project-id]
```

It always reads from a file literally named `.env` in the current
directory — passing `.env.render` as an extra arg gets silently ignored
(no error), so the push actually re-pushed the OLD 17-var `.env` instead
of the intended 35-var file. `pxxl env list` after that push still showed
only the same 17 keys as before — the push "succeeded" but pushed the
wrong file. Caught this only because the user explicitly asked "are you
sure the env are completed" and it was worth re-checking rather than
trusting the earlier success message.

**Correct procedure:** always copy/overwrite the target file to the
literal `.env` path before pushing:

```bash
cp .env.render .env
pxxl env push --force <project-id>
pxxl env list <project-id>   # verify count/names before trusting it
pxxl redeploy <project-id>   # env only takes effect after a redeploy
```

Confirmed after redoing it this way: `pxxl env list` on `entry-test`
now shows all 35 keys. Redeployed, and `/api/health` went through the
same one-shot cold-start "unreachable" on the very first check post-deploy,
then "connected" on every check after — consistent with the earlier
cold-start finding, not a new problem.

**Takeaway:** never trust a CLI's generic success message
(`✓ Environment variables replaced`) as proof the *intended* file was
pushed — always follow up with `pxxl env list` and diff the key names
against what was meant to be sent.
