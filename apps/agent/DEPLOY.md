# Deploying apps/agent (the Entry worker) — Render

This is the current, verified hosting target after Pxxl (platform-side proxy
rollover bug, unfixable from our side), Fly.io (5-min trial kill-switch),
and Northflank/Zeabur (require payment method upfront) were all ruled out.

## Render service settings

- **Root Directory:** repo root (leave blank / `.`)
- **Build Command:**
  ```
  npm install && npm run build --workspace=apps/agent
  ```
- **Start Command:**
  ```
  npm run start --workspace=apps/agent -- --host 0.0.0.0
  ```
- **Health Check Path:** `/` (Render's own TCP/HTTP port-scan just needs
  *something* listening; `eve start` itself separately waits up to 240s for
  `/eve/v1/health` to return healthy before it will exit non-zero)
- **Plan:** free tier is NOT sufficient — see "Known gotchas" below.

## Required environment variables

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Pooled Neon Postgres connection string |
| `DATABASE_URL_UNPOOLED` | Direct (unpooled) Neon connection string |
| `DATABASE_POOL_MAX` | Cap on internal pg pool size (we use `5`) |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `24.15.0` (pin — Render defaults can drift) |
| `NODE_OPTIONS` | see below — memory cap + DNS order + safety-net preload |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key (model routing) |
| `E2B_API_KEY` / `E2B_API_KEY_2` | Sandbox execution backend |
| `EVE_INTERNAL_JWT_SECRET` | Must match the web app's value |
| `BYOK_ENCRYPTION_KEY` | Must byte-for-byte match the web app's value |
| `CREDENTIAL_VAULT_KEY` | Must byte-for-byte match the web app's value |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob storage |
| `ADMIN_DEBUG_TOKEN` | Internal diagnostics auth |
| `ENTRY_WEB_ORIGIN` | `https://entry.oneshotsx.cv` (CORS) |
| `WORKFLOW_TARGET_WORLD` | `@workflow/world-postgres` |

**`NODE_OPTIONS` value:**
```
--max-old-space-size=400 --dns-result-order=ipv4first --require /opt/render/project/src/apps/agent/safety-net.cjs
```
The `--require` path MUST be the absolute Render path to the **source-controlled**
`apps/agent/safety-net.cjs` (not anything under `.output/`, which doesn't exist
yet during the build command — NODE_OPTIONS applies to both build and start).

## Known gotchas (all bit us in production)

1. **NODE_OPTIONS applies to the build command too.** Any `--require` path
   must exist from git checkout onward, not be a build output.
2. **Render's build cache can hold an already-patched `node_modules`.**
   If you change a `patches/*.patch` file, trigger the next deploy with
   `clearCache: "clear"` in the Render API deploy call (or "Clear build
   cache & deploy" in the dashboard) — otherwise `patch-package` tries to
   re-apply a patch on top of an already-patched file and the build fails
   with a cryptic "Failed to apply patch" error.
3. **Free tier CPU is too throttled for this app's boot sequence.**
   `eve start` compiles/discovers the agent twice (once in its own CLI
   process, once in the spawned server child) before the HTTP port opens.
   That's ~15-45s of real compile work on decent hardware, but on Render
   free tier's heavily CPU-limited shared instances it can take 200s+ —
   right up against (or past) `eve`'s own 240s health-wait timeout, causing
   `Built server did not become healthy within 240s` even though the code
   itself is fine. **Use at least the Starter plan; Standard (2GB/1 CPU) is
   safer** given this app's Prisma + E2B + multi-provider SDK footprint.
4. **`connectionTimeoutMillis` matters.** `@workflow/world-postgres`'s pool
   has no connect timeout by default (waits forever). We patched it to
   default to 8000ms (`WORKFLOW_POSTGRES_CONNECT_TIMEOUT_MS` env var
   overrides it) and wrapped the bootstrap call in try/catch so a workflow-
   world init failure degrades gracefully instead of hanging/crashing boot.
5. **BYOK_ENCRYPTION_KEY / CREDENTIAL_VAULT_KEY must match the web app
   exactly.** Any drift between Vercel (web) and the worker silently breaks
   BYOK decryption.

## Verifying a deploy locally before pushing

```bash
cd apps/agent
npm run build
PORT=18080 HOST=0.0.0.0 NODE_OPTIONS="--max-old-space-size=400 --require $(pwd)/safety-net.cjs" \
  node .output/server/index.mjs &
sleep 12
curl -s localhost:18080/eve/v1/health
```
Should return `{"ok":true,"status":"ready",...}` within ~10s even if the DB
is unreachable.
