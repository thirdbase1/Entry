# BYOK system: architecture, endpoint wiring, and error logging

(2026-07-21 full audit -- "analyze the whole backend BYOK system and how it
connects to endpoints, log everything so we can easily catch errors")

## 1. Data model
`UserModelProvider` (a connection: label, compatibility mode, baseUrl,
`encryptedApiKey`) has many `UserModelProviderModel` rows (a specific model
id on that connection, isEnabled, reasoningEnabled, lastTestStatus/Error).
Both tables live in `packages/db/prisma/schema.prisma`.

Keys are AES-256-GCM encrypted at rest (`packages/db/src/crypto/byok.ts`)
under one env secret, `BYOK_ENCRYPTION_KEY`. Never logged, never returned
to the client past creation (`hasApiKey: boolean` only; `reveal-key` route
is the one deliberate exception, gated on the owning session).

## 2. CRUD endpoints (all under `/api/user/byok/providers`)
- `GET /providers` -- list, with models, keys never included.
- `POST /providers` -- create a connection.
- `PATCH /providers/[providerId]` -- edit label/baseUrl/compatibility/key.
- `DELETE /providers/[providerId]`
- `POST /providers/[providerId]/fetch-models` -- probe the provider's own
  `/models` list endpoint to auto-populate rows.
- `POST /providers/[providerId]/models` -- add one model id manually.
- `PATCH /providers/[providerId]/models/[modelId]` -- toggle enabled/reasoning.
- `DELETE /providers/[providerId]/models/[modelId]`
- `POST /providers/[providerId]/models/[modelId]/test` -- fire a real,
  minimal completion against the provider to confirm the key/baseUrl work.
- `GET /providers/[providerId]/reveal-key` -- decrypt-and-return, once,
  session-gated.

Every one of the above is wrapped in `withApiErrorHandling` (below) --
confirmed by grep across all 7 route files, zero exceptions.

## 3. How a BYOK model actually answers a chat turn
`ChatInput` (model picker) -> `byok:<modelRowId>` value -> `chat-config.tsx`
parses it into `{ byokModelId }` -> `DirectChatInterface`'s `useChat`
transport posts to **`/api/direct/chat`** (the one and only endpoint any
chat turn hits, BYOK or Gateway) -> that route calls
`resolveByokModel(byokModelId, userId)` (`lib/byok/resolve-model.ts`) BEFORE
any streaming starts, so a bad key / wrong model id / ownership mismatch
surfaces as a clean JSON error, never a half-open stream -- then
`buildModelClient` (`lib/byok/build-model-client.ts`) constructs the real
per-compatibility-mode SDK client (`@ai-sdk/openai`, `-anthropic`,
`-google`, or `-openai-compatible`) and `streamText` runs the turn directly
against the user's own endpoint. No Gateway involvement on this path at
all, by construction.

The OpenAI-compatible branch swaps in a custom `fetch`
(`gateway-retry-fetch.ts`) that retries a documented family of transient
multi-node-relay glitches (any 404, or a short/generic 5xx) without
retrying genuinely permanent failures (auth/quota/rate-limit/model-not-
found keyword match) -- see that file's own comment for the full,
previously-reproduced incident history.

## 4. Logging -- what already existed, and what changed today

### Already in place (verified, not touched)
- `withApiErrorHandling` (`lib/api-error.ts`) wraps every BYOK route AND
  `/api/direct/chat` itself: any thrown error -> `console.error` (live
  `vercel logs` tail) + `logError()` -> durable `ErrorLog` Prisma table,
  then a clean JSON 500 back to the client (never an opaque empty body).
- `resolveByokModel`'s decrypt-failure path turns a raw crypto crash (e.g.
  from a rotated `BYOK_ENCRYPTION_KEY`) into an actionable message instead
  of propagating the opaque "Unsupported state..." error.
- `/api/admin/errors?source=...&limit=...` -- queryable read-only window
  into `ErrorLog`, admin-session or `ADMIN_DEBUG_TOKEN` gated. This is the
  fastest way to answer "what's actually failing in prod" without a local
  DB connection.
- `streamText`'s own `onError` in `direct/chat/route.ts` already calls
  `logError` for in-flight streaming failures (network drop mid-turn,
  provider timeout, etc.) -- separate from the pre-flight resolve step
  above, covers the other half of the turn's lifecycle.

### Real gaps found and fixed today
1. **No route-param context on errors.** `withApiErrorHandling` only ever
   logged `{ url, method }` -- for a dynamic route like
   `/providers/[providerId]/models/[modelId]/test`, that meant reading
   `error_logs` never told you WHICH provider/model without manually
   parsing the URL. Fixed: it now also awaits Next's own `{ params }`
   promise (already handed to every route handler, zero extra cost) and
   folds `routeParams` (e.g. `{ providerId, modelId }`) into the log
   context automatically, for every dynamic BYOK route at once.
2. **Retry activity was 100% ephemeral.** `gateway-retry-fetch.ts` only
   ever did `console.warn` per attempt -- Vercel's log tail is short-lived
   (this exact gap is *why* `ErrorLog`/`logError` exists per that file's
   own comment, yet this one caller never actually used it). Fixed: it now
   takes an optional `{ providerLabel, userId }` context (wired through
   from `resolveByokModel` and the settings page's "Test connection"
   route, the only two callers) and persists two new durable, distinctly-
   sourced events:
   - `byok-gateway-retry-recovered` -- succeeded after N attempts (was
     previously invisible even on success).
   - `byok-gateway-retry-exhausted` -- gave up after all attempts, with
     the final status + truncated body.
   This is what turns "is this one relay getting flakier over time" into
   a queryable question instead of something only visible live.
3. **A crashed page could look identical to "the click didn't
   register".** Not BYOK-specific, but directly relevant to catching BYOK
   UI errors too (settings page, model picker): added a root
   `ErrorBoundary` (`components/error-boundary.tsx`) that catches any
   render-time exception, shows a real "Something broke" fallback instead
   of going silently inert, and POSTs to a new `/api/client-error` route
   that runs it through the exact same `logError` pipeline as every server
   error above. `ChatInput`'s send handler also got the same treatment for
   the one place a crash could NOT be caught by a React error boundary at
   all (event handlers): a synchronous throw from `onSend` is now caught
   inline, shown as a visible inline error, and the typed message/attach-
   ments are restored instead of silently vanishing.

## 5. Net result
Every layer of the BYOK pipeline -- CRUD routes, the chat-turn resolve
step, the streaming turn itself, the retry-wrapped fetch, and now the
client-side render/send path -- reports into the same `ErrorLog` table,
queryable via `/api/admin/errors`, with enough context (route params,
provider label, userId) to root-cause a report without needing to
reproduce it live first.
