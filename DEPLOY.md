# Deploying Entry

## Prerequisites

1. **Vercel account** — the app deploys to Vercel (Next.js + eve agent).
2. **Postgres with pgvector** — Neon, Supabase, or AWS RDS. Must have the `vector` extension:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. **Upstash Redis** — for caching, sessions, OAuth state, and rate limiting.
4. **Vercel AI Gateway API key** — get one at https://vercel.com/ai-gateway.
5. **Parallel API key** — for web search tools (https://parallel-web.com).

## Step 1 — Database Setup

```bash
# Install dependencies (runs prisma generate automatically via postinstall)
npm install

# Create the database schema
cp .env.example .env
# Edit .env with your DATABASE_URL (SHADOW_DATABASE_URL only needed for
# `npm run db:migrate`, local dev — skip it for a straight prod deploy)

# Run migrations
npm run db:deploy   # production (applies pending migrations)
# OR
npm run db:migrate  # local dev (creates + applies migrations)
```

Note: this project uses Better Auth with the **Prisma adapter**, on a
hand-mapped schema that already matches Better Auth's table contract
(`packages/db/prisma/schema.prisma`). Migrations run through Prisma's own
CLI (`db:deploy`/`db:migrate` above) — Better Auth's own `npx auth migrate`
command does **not** support the Prisma adapter (only its built-in Kysely
adapter), so it's not part of this flow. `npx auth generate` (schema
scaffolding) also isn't needed since the schema is already written by hand.

## Step 2 — Environment Variables

Set all variables from `.env.example` in your Vercel project settings
(Settings → Environment Variables). Only 3 are actually required to boot —
everything else is either auto-injected by Vercel or a hardcoded code
constant (see `.env.example`'s comments for exactly which file to edit if
you want to change one of those):

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection string |
| `UPSTASH_REDIS_URL` | ✅ | Upstash Redis REST URL |
| `BETTER_AUTH_SECRET` | ✅ | Random 32+ char string (see below) |
| `EVE_INTERNAL_JWT_SECRET` | ✅ | Random string for eve↔web JWTs — genuine cross-service secret, can't be hardcoded |
| `AI_GATEWAY_API_KEY` | ⬜ [auto] | Vercel injects `VERCEL_OIDC_TOKEN` automatically; only set this for local dev |
| `PARALLEL_API_KEY` | ⬜ | Web search tool — search/crawl tools no-op without it |
| `SENDBYTE_API_KEY` | ⬜ | Email (magic links) — app works without it |
| `GOOGLE_CLIENT_ID/SECRET` | ⬜ | Google OAuth sign-in |
| `GITHUB_CLIENT_ID/SECRET` | ⬜ | GitHub OAuth sign-in |
| `BLOB_READ_WRITE_TOKEN` | ⬜ [auto] | Auto-provisioned when you attach a Blob store on Vercel |
| `BYOK_ENCRYPTION_KEY` | ⬜ | Required only if users will add BYOK providers with an API key; generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |

**Not env vars, by design** — `BETTER_AUTH_URL` (derived from Vercel's
auto-injected `VERCEL_PROJECT_PRODUCTION_URL`), `AUTH_ALLOW_SIGNUP` /
`AUTH_REQUIRE_EMAIL_VERIFICATION` / password length / session TTLs
(hardcoded in `packages/auth/src/config.ts`), `EARLY_ACCESS_CONTROL_ENABLED`
(hardcoded `true` in `packages/features/src/service.ts`), `SERVER_NAME` /
`APP_VERSION` / `APP_BASE_URL` (hardcoded/request-derived in
`apps/web/app/api/server/config/route.ts`). These are one-time app-policy
decisions, not per-deployment config — change them in code and redeploy.

### Generate BETTER_AUTH_SECRET

```bash
openssl rand -base64 32
```

### Generate EVE_INTERNAL_JWT_SECRET

```bash
openssl rand -hex 32
```

## Step 3 — OAuth Provider Setup (optional)

### Google
1. Go to https://console.cloud.google.com/apis/credentials
2. Create an OAuth 2.0 Client ID
3. Authorized redirect URI: `https://<your-domain>/api/auth/callback/google`

### GitHub
1. Go to https://github.com/settings/developers
2. Create a new OAuth App
3. Authorization callback URL: `https://<your-domain>/api/auth/callback/github`

## Step 4 — Deploy to Vercel

**⚠️ IMPORTANT — use the prebuilt hand-assembled deploy below, not a plain
`vercel --prod` and not even `vercel build --prod`.**

As of this Next.js version + Vercel CLI, Vercel's own **build
orchestration is broken for this project — both paths**:

1. A real `vercel --prod` remote build dies silently with
   `Command "npm run build" exited with 1` (zero error text, zero stack
   trace), right after `Skipping validation of types`.
2. `vercel build --prod` run locally (Vercel CLI driving its own build
   orchestration, just not on their remote machine) hits the **same**
   silent crash — so "build locally with the Vercel CLI, then
   `--prebuilt` deploy" (the previously-documented workaround) no longer
   works either.

This matches a known, currently-open Vercel platform bug affecting this
Next.js version around their internal "Applying modifyConfig from Vercel"
step (see https://github.com/vercel/vercel/issues/16409 and
https://community.vercel.com/t/next-js-16-2-6-remote-build-fails/42402 —
same failure class). It is **not** caused by our code: a plain `next build`
/ `npm run build`, run completely outside any Vercel orchestration layer,
always completes cleanly.

**The actual fix: skip Vercel's build orchestration entirely.** Build with
plain `npm run build` (works reliably — `next.config.ts` already sets
`output: 'standalone'` for this), then hand-assemble the Vercel Build
Output API v3 structure ourselves (`.vercel/output/...`) and deploy that
directly. This is exactly what `@vercel/next`'s own builder would have
produced — we're just doing it by hand once instead of letting their
crashing orchestrator do it.

**⚠️ New migrations need an extra step — read this if `packages/db/prisma/migrations`
has any new folder since your last deploy.** `npm run build` (below) runs
`prisma migrate deploy` locally, using whatever `DATABASE_URL` is in your
shell — but Neon's Vercel integration does not let `vercel env pull`/`env
ls` export the real production value at all (confirmed: comes back empty
by design), so there is no way to point a LOCAL `prisma migrate deploy` at
the real production database. `npm run build`'s migration step now fails
loudly instead of silently succeeding against the wrong one if
`DATABASE_URL` looks local (see
`packages/db/scripts/guard-production-migrate.js`) — this is exactly what
happened on 2026-07-11 (a migration "succeeded" against `.env`'s local dev
DB while real production silently never got it, then broke at runtime).

**The actual fix: apply new migrations to production from inside the
deployed app itself**, where `DATABASE_URL` resolves to the real value —
`POST /api/admin/db/migrate` (any logged-in admin user) applies every
migration folder not yet recorded in production's `_prisma_migrations`,
the same way `prisma migrate deploy` would. `GET` on the same route shows
applied vs. pending without changing anything. Deploy order for a release
with new migrations: deploy first (below), then call this route once —
the running code and the schema it expects go live together either way,
and any request that touches the new table/column simply waits the few
seconds until the migrate call completes right after.

For a release with NO new migrations (verify: `git diff` against
`packages/db/prisma/migrations` is empty since the last deploy), skip the
local migrate step entirely rather than fighting the guard —
`SKIP_PRODUCTION_MIGRATE_GUARD=1 npm run build`.

**⚠️ Commit and push to GitHub BEFORE building/deploying — never skip this.**
This project's deploy path builds from a local working tree and ships
straight to Vercel via `--prebuilt`, entirely bypassing git. Nothing
about that path requires a commit to exist, which makes it dangerously
easy to deploy real, working code that was never actually saved anywhere
durable — confirmed real incident (2026-07-18): a full feature (durable
per-user memory: new Prisma model/migration, a new tool, persona.ts
changes, direct/chat wiring) went through multiple build+deploy cycles
and was live in production while sitting completely uncommitted in a
scratch working directory, indistinguishable from having never been
written down at all. It only survived because that scratch directory
happened not to get cleared before someone noticed — a temp/dev
directory is never guaranteed to survive between sessions, and any code
that only exists there and in a deployed Vercel bundle has no real
backup: it can't be diffed, reviewed, reverted to, or recovered if that
directory is gone, regardless of how "safe" the deploy itself was.

```bash
git add -A
git commit -m "<describe what changed>"
git push origin main
```

Do this for EVERY deploy, not just ones that "feel big" — the whole point
is that there's no reliable way to tell in advance which working
directory won't survive to the next session.

```bash
# One-time, if you haven't already:
npm i -g vercel
vercel link
vercel pull --yes --environment production   # pulls project settings (env vars stay live on Vercel's side)

# Build + hand-assemble .vercel/output (installs deps, runs `npm run build`,
# copies the standalone bundle + static assets + public/, writes
# .vc-config.json and config.json with the images block). See
# scripts/build-vercel-output.sh for exactly what this does, and
# apps/web/scripts/vercel-launcher.js for the Lambda entrypoint it wires up.
./scripts/build-vercel-output.sh

# Ship the hand-built artifacts straight to Vercel, skipping their broken
# build step entirely
npx vercel deploy --prebuilt --prod --archive=tgz --token "$VERCEL_TOKEN"
```

Notes:
- `vercel deploy --prebuilt` requires `.vercel/output` to already exist and
  be valid Build Output API v3 (that's what the script produces) — it does
  **not** run any build itself, so this sidesteps Vercel's broken
  orchestration completely, unlike `vercel build --prod` which routes
  through the same crashing code path.
- Runtime env vars (DATABASE_URL, secrets, etc.) are unaffected — Vercel
  still injects the real project env vars into the deployed function at
  request time, exactly like a normal deploy. This only changes *how the
  build artifacts are produced*, not runtime configuration.
- `supportsResponseStreaming: true` in `.vc-config.json` is required for
  eve's SSE chat streaming to work — don't drop it if you ever hand-edit
  that file.
- After bypassing `@vercel/next`'s builder, Vercel's automatic
  `/_next/image` optimization wiring is also bypassed — the script adds an
  equivalent `images` block to `.vercel/output/config.json` itself
  (mirrored from `next.config.ts`'s own `images` settings) so
  `next/image` keeps working. If you add new remote image domains, update
  `next.config.ts`'s `images` config and rerun the script — it re-derives
  this block automatically, nothing to hand-edit.
- **If a future Vercel CLI/Next.js release fixes the remote-build
  regression**, try a plain `vercel --prod` first on the next release —
  fall back to `./scripts/build-vercel-output.sh` +
  `vercel deploy --prebuilt --prod` if the same silent failure reappears.
- Importing the GitHub repo via Vercel's dashboard is **not** currently
  viable — dashboard Git-push deploys use the same broken remote builder.

## Step 5 — Post-Deploy Verification

1. Visit `https://<your-domain>/api/health` — should return `{ status: "ok" }`.
2. Visit `https://<your-domain>/sign-in` — should show the login page.
3. Try signing in with email/password or OAuth.
4. Start a chat at `/chats` — eve agent should respond via `/eve/v1/*` routes.
5. **Record a Version** (see Step 6) — this is not optional, it's how the
   product's own "revert if I did something wrong" feature stays usable.

## Step 6 — Record a Version (do this after EVERY production deploy)

The chat UI's "History" tab (`ChatDeploymentsTab`, backed by
`/api/admin/versions`) is a custom, app-native checkpoint system — plain-
language labels, no git/GitHub/Vercel jargon shown to the user — that lets
the user instantly self-service revert production if a change breaks
something, with zero rebuild wait (it rides Vercel's Instant Rollback
under the hood, repointing production at the already-built artifact from
that version). It only works if a version row actually exists for every
build that goes live, so:

**Immediately after every successful `vercel deploy --prebuilt --prod`**,
record what shipped:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_DEBUG_TOKEN" \
  -H "Content-Type: application/json" \
  https://<your-domain>/api/admin/versions \
  -d '{"label":"<one plain-language sentence describing what changed>"}'
```

- The label is what the USER sees in the History tab — write it for them,
  not for a git log (e.g. "Fixed the browser tool crashing after 2
  messages", not "fix: ToolLoopAgent smoothStream handler").
- This call reads whatever Vercel deployment is *currently* live and
  stamps the new version to it — so it must run right after the deploy
  actually finishes, not before.
- Skipping this step means that deploy's changes are invisible to the
  user's revert UI — they'd have no way to get back to it if a *later*
  change breaks something.

## Architecture Notes

- **Auth** is handled entirely by [Better Auth](https://www.better-auth.com/)
  (`packages/auth`) — email/password, magic links, email verification, and
  Google/GitHub social sign-on all go through the single catch-all route
  `/api/auth/[...all]`. Session cookies, token refresh, and OAuth callbacks
  are all managed by the library; no custom JWT/cookie code to maintain.
- **eve agent** is mounted via `withEve()` in `next.config.ts` — the agent's
  HTTP routes live at `/eve/v1/*` on the same origin. No separate server needed.
- **Chat streaming** uses eve's built-in SSE transport (not a custom `/api/chat`
  route). The `useEveAgent` React hook connects to `/eve/v1/*` automatically.
- **Queue handlers** are registered as Vercel Cron/Queue triggers in `vercel.json`.
- **Prisma** uses the v7 driver adapter (`@prisma/adapter-pg`) — no Rust engine.
  The client is generated at install time via the `postinstall` script.
- **BlockSuite** (doc editor) ships raw TypeScript source — `next.config.ts`
  handles transpilation + babel-loader for decorators.
- **Sandbox (browser/python execution)** needs no manual snapshot-baking or
  env vars — eve's own build-time prewarm (`apps/agent/agent/sandbox/sandbox.ts`'s
  `bootstrap()` + `revalidationKey()`) automatically bakes and caches a Vercel
  Sandbox template on every deploy (agent-browser + Chrome + Python deps
  preinstalled), reusing the cached template across deploys when the seed is
  unchanged. This fully replaces the legacy hand-rolled
  `KERNEL_BROWSER_SNAPSHOT_ID`/`KERNEL_PYTHON_SNAPSHOT_ID` approach in the old
  `packages/ai/src/kernel/*` code, which is dead/unused — nothing imports it.

## Local Development

```bash
cp .env.example .env
# Fill in at minimum: DATABASE_URL, UPSTASH_REDIS_URL, AI_GATEWAY_API_KEY, BETTER_AUTH_SECRET, EVE_INTERNAL_JWT_SECRET

npm install        # generates Prisma client
npm run db:deploy  # applies migrations
npm run dev        # starts Next.js dev server on :3000
```

The eve agent runs inside the Next.js dev server via `withEve()` — no separate
`eve dev` process needed.
