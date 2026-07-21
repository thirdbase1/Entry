# Deploying the agent worker to Fly.io

This documents the standalone `apps/agent` worker deployment — the
off-Vercel host that removes Vercel's 300s Function execution cap for
long-running agent turns. The web app (`apps/web`) still deploys to
Vercel as documented in `DEPLOY.md`; this file is only about the agent
worker.

## Why Fly.io, and why GitHub Actions builds it (not your machine)

Pxxl, Render (free/starter tier), Northflank, and Zeabur were all tried
first and ruled out (proxy-rollover bugs, RAM limits, or payment-method
requirements — see `pxxl.deployment.md` for the Pxxl postmortem). Fly.io
works, but building the Docker image **from a constrained sandbox/CI
environment straight to Fly's remote builder is unreliable**: it exercises
a wireguardless HTTPS tunnel + buildkit h2c upgrade that Fly's edge proxy
intermittently 500s on, and flyctl's `buildWireguardlessClientOpts` also
has a real bug (missing `dockerclient.WithHost(host)`) that crashes the
remote-builder heartbeat with "missing hostname" in hardened/sandboxed
network namespaces.

**The fix: build the image with a real Docker daemon that isn't inside a
constrained sandbox — a GitHub Actions runner.** `.github/workflows/fly-deploy.yml`
does exactly that: checks out the repo, installs `flyctl`, and runs
`flyctl deploy --local-only` so the image is built right there on the
runner and pushed straight to Fly's registry, never touching the
buggy remote-builder path at all.

## What's live right now

- App name: `entry-agent-worker`
- URL: https://entry-agent-worker.fly.dev
- Region: `lhr` (London)
- VM: `shared-cpu-1x`, 2GB RAM, `min_machines_running=1` (2 machines currently)
- Health check: `GET /eve/v1/health` → `{"ok":true,"status":"ready"}`

## Files involved

| File | Purpose |
|---|---|
| `fly.toml` | Fly app config — region, VM size, health check, `[http_service]` |
| `Dockerfile.agent` | Builds `apps/agent` from the monorepo root (npm workspaces need the full tree) |
| `.github/workflows/fly-deploy.yml` | Builds + deploys on every push to `main` that touches `fly.toml`, `Dockerfile.agent`, `apps/agent/**`, or `packages/**` — also runnable manually |

## Redeploying

**Automatic:** just push to `main` with changes under the paths above —
the workflow picks it up.

**Manual (no code change, e.g. to pick up a secrets rotation):**
```bash
# Via GitHub UI: Actions tab → "Deploy Agent Worker to Fly.io" → Run workflow
# Via API:
curl -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/thirdbase1/Entry/actions/workflows/fly-deploy.yml/dispatches \
  -d '{"ref":"main"}'
```

**One-time setup this required** (already done, documented for the next
time a fresh Fly app/GitHub repo needs this from scratch):
1. `flyctl apps create entry-agent-worker` (or `fly launch --no-deploy`
   the first time, to generate `fly.toml`).
2. Generate a Fly API token (`flyctl tokens create deploy -a entry-agent-worker`
   or an org-scoped token) and store it as a GitHub Actions repo secret
   named `FLY_API_TOKEN`:
   `Settings → Secrets and variables → Actions → New repository secret`.
3. Push `fly.toml`, `Dockerfile.agent`, `.github/workflows/fly-deploy.yml`
   to `main`.

## Secrets the worker needs (`flyctl secrets set KEY=value -a entry-agent-worker`)

| Secret | Notes |
|---|---|
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | Same Neon Postgres as the web app |
| `DATABASE_POOL_MAX` | Kept low (worker has less headroom than a Vercel Function) |
| `BYOK_ENCRYPTION_KEY` | Must match the value on Vercel — same encrypted BYOK rows are read from both |
| `CREDENTIAL_VAULT_KEY` | Same as above |
| `EVE_INTERNAL_JWT_SECRET` | **Must exactly match** the value set on Vercel (`apps/web`'s `/api/agent-token` signs with it, this worker's `jwtHmac()` verifies with it) |
| `ENTRY_WEB_ORIGIN` | The production web origin (`https://entry.oneshotsx.cv`) — used for the worker's CORS allow-origin |
| `AI_GATEWAY_API_KEY` | **Required and easy to miss** — on Vercel, model calls authenticate via the auto-injected `VERCEL_OIDC_TOKEN`; that doesn't exist off-Vercel, so the worker needs a real AI Gateway API key instead. Create one with `vercel ai-gateway api-keys create --name entry-agent-worker-fly` |
| `E2B_API_KEY` (+ `_2` fallback) | Sandbox tool execution |
| `ADMIN_DEBUG_TOKEN`, `BLOB_READ_WRITE_TOKEN`, `WORKFLOW_POSTGRES_JOB_PREFIX` | Same values as Vercel |
| `NODE_OPTIONS` | Heap-limit tuning for the 2GB VM |

Rotate a secret with `flyctl secrets set KEY=newvalue -a entry-agent-worker`
— this triggers an automatic rolling restart of both machines, no separate
deploy needed. If you rotate `EVE_INTERNAL_JWT_SECRET`, rotate it on Vercel
in the same breath (see "Wiring the web app" below) or every existing
browser session will fail auth until both sides match again.

## Wiring the web app to point at this worker

Two env vars on the **Vercel** project (`apps/web`), production target:

| Var | Value |
|---|---|
| `NEXT_PUBLIC_EVE_AGENT_HOST` | `https://entry-agent-worker.fly.dev` — this is a `NEXT_PUBLIC_` var, so it's **inlined at Next.js build time**, not read at runtime. Changing it requires a full rebuild + redeploy of the web app, not just an env var update on Vercel's dashboard. |
| `EVE_INTERNAL_JWT_SECRET` | Must be byte-for-byte identical to the same-named secret on the Fly worker |

Once both are set and the web app is rebuilt/redeployed:
`apps/web/lib/eve-agent-host.ts` exports a non-undefined `EVE_AGENT_HOST`,
which flips `chat-interface.tsx` / `direct-chat-interface.tsx` from the
in-process `withEve()` mount over to calling the Fly worker directly —
the browser calls `/api/agent-token` (same-origin, Better Auth session
cookie) to mint a 5-minute JWT, then opens the NDJSON stream straight to
`https://entry-agent-worker.fly.dev/eve/v1/session...` with that JWT as a
bearer token. See the long comment at the top of
`apps/agent/agent/channels/eve.ts` for the full auth-fallthrough design
(same-origin cookie check first, then `jwtHmac()`, then `localDev()`).

## Verifying it's working end-to-end

```bash
# 1. Health check (no auth)
curl https://entry-agent-worker.fly.dev/eve/v1/health

# 2. CORS preflight from the real production origin
curl -i -X OPTIONS \
  -H "Origin: https://entry.oneshotsx.cv" \
  -H "Access-Control-Request-Method: POST" \
  https://entry-agent-worker.fly.dev/eve/v1/session
# expect: access-control-allow-origin: https://entry.oneshotsx.cv

# 3. Full session create + stream, signing a short-lived HS256 JWT with
#    the SAME secret set as EVE_INTERNAL_JWT_SECRET on both sides
#    (sub/iss/aud must match what apps/web/app/api/agent-token/route.ts signs):
python3 -c "
import jwt, time
secret = 'PASTE_THE_SECRET_HERE'
print(jwt.encode({
    'sub': 'debug-user', 'iss': 'entry-web', 'aud': 'entry-agent',
    'iat': int(time.time()), 'exp': int(time.time()) + 300,
}, secret, algorithm='HS256'))
"
curl -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token from above>" \
  -H "Origin: https://entry.oneshotsx.cv" \
  -d '{"message":"ping"}' \
  https://entry-agent-worker.fly.dev/eve/v1/session
# expect: HTTP 202 with a sessionId, then GET .../session/<id>/stream?streamIndex=0
# to watch the NDJSON event stream.
```

## Known gap as of 2026-07-21

The worker now authenticates and streams correctly end-to-end, but real
model calls fail with `GatewayInternalServerError: A positive credit
balance is required` — the Vercel team account (`hobby` plan) has
exhausted its $5/month free AI Gateway credit tier. This is a **billing
state on the Vercel team account**, not a code or wiring problem — it
would affect Vercel-hosted chat too once free credits run out, since both
the Vercel `VERCEL_OIDC_TOKEN` path and this worker's `AI_GATEWAY_API_KEY`
draw from the same team credit balance. Fix: add a payment method and
either purchase AI Gateway credits or enable auto top-up from the Vercel
dashboard's AI Gateway tab.
