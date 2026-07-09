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

**⚠️ IMPORTANT — use the prebuilt deploy workflow below, not a plain `vercel --prod`.**

As of this Next.js version (16.2.10) + Vercel CLI 54.21.1, Vercel's own
**remote build container has a platform-side bug**: it dies silently with
`Command "npm run build" exited with 1` (zero error text, zero stack trace)
immediately after `Skipping validation of types`, every single time,
regardless of Node memory limits (`NODE_OPTIONS=--max-old-space-size`) or
worker-count settings (`experimental.cpus`). This matches a known,
currently-open Vercel platform bug affecting Next.js 16.2.x builds around
their internal "Applying modifyConfig from Vercel" step (see
https://github.com/vercel/vercel/issues/16409 and
https://community.vercel.com/t/next-js-16-2-6-remote-build-fails/42402 —
same failure class, different Next.js patch version). It is **not** caused
by our code: a real `vercel build` run outside Vercel's remote container
(i.e. anywhere else — this repo's CI runner, a local machine, this
project's dev sandbox) completes cleanly end-to-end every time.

**The fix/workaround: build outside Vercel's remote container, then deploy
the prebuilt output.** This entirely bypasses the buggy remote build step:

```bash
npm i -g vercel
cd open-agent-next
vercel link
vercel pull --yes --environment production   # pulls project settings + env

# Build LOCALLY (or in CI) — not on Vercel's remote builder
vercel build --prod

# Ship the artifacts Vercel's remote builder would have produced, skipping
# their broken build step entirely
vercel deploy --prebuilt --prod
```

Note: `vercel pull` cannot retrieve the plaintext of env vars marked
**Sensitive** in the dashboard (by design — Vercel never exposes those
values again after creation). That's fine for `DATABASE_URL` /
`BETTER_AUTH_SECRET` / etc: the **build** only needs *a* syntactically valid
value in each (e.g. point `DATABASE_URL` at a local/throwaway Postgres and
run `prisma migrate deploy` against that — it's idempotent and only
generates the Prisma client + does static analysis, it doesn't touch
production data). The **runtime** (the deployed serverless functions)
always reads the real Sensitive values Vercel injects live from your actual
project settings — a prebuilt deploy does not change or freeze those.

If a future Vercel CLI/Next.js release fixes the remote-build regression, a
plain `vercel --prod` (full remote build) should work again — try that
first on the next release and fall back to the prebuilt workflow above if
the same silent failure reappears.

Or import the GitHub repo via Vercel's dashboard — the `vercel.json` and
`package.json` build settings are already configured (note: dashboard
Git-push deploys use Vercel's remote builder too, so they're subject to the
same bug until Vercel patches it).

## Step 5 — Post-Deploy Verification

1. Visit `https://<your-domain>/api/health` — should return `{ status: "ok" }`.
2. Visit `https://<your-domain>/sign-in` — should show the login page.
3. Try signing in with email/password or OAuth.
4. Start a chat at `/chats` — eve agent should respond via `/eve/v1/*` routes.

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
