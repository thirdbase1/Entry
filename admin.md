# Entry — Admin, Billing & Multi-Key Routing Plan
_Last updated: 2026-07-19. Author: Lyra (Claude Sonnet, via Base44 Superagent), written as a build spec for Entry's own in-app agent (Claude Fable 5) to execute against._

## 0. Goals (from the owner's ask)

1. Admin page must track *everything* and control *everything* — nothing left out.
2. A dedicated Billing / Analysis page: every user's usage, in dollars, accurate.
3. We may drop Vercel AI Gateway — need our own replacement for what it currently gives us (multi-provider routing, failover).
4. Multiple base URLs + multiple API keys, auto-routed for speed and smoothness (load balancing / failover), so users don't feel latency or outages.
5. Users subscribe, get AI credit, see their balance in $.
6. Usage cost per AI turn must be as close to 100% accurate as possible.
7. This doc is the spec — Fable 5 builds against it inside Entry.

## 1. Where we are today

Already live:
- `Feature` / `UserFeature` tables — flag-based plan system (`free_plan_v1`, `starter_plan_v1`, `pro_plan_v1`, `power_plan_v1`, `studio_plan_v1`, `administrator`, `early_access`, `unlimited_copilot`).
- Each plan config carries `aiCreditAllowance` — added 2026-07-19, **hardcoded in `packages/features/src/common.ts`**. This violates Goal #7 (repricing lever) and must move to a DB table (see §3.1).
- Admin page at `/admin` — Users tab (list, ban/enable, feature toggles) and Versions tab (deploy history + instant rollback). Gated by `featureService.isAdmin` (session-based), not the debug bearer token.
- All chat/agent traffic currently goes through Vercel AI Gateway (zero token markup per Vercel's own pricing page, but real costs: $0.10 per 1,000 requests per allow-listed provider, and no native concept of "which of my own resold keys should serve this request" — Gateway routes to *providers*, not to *our specific negotiated deals*).
- **No usage metering exists yet.** No table records tokens, cost, or which model/provider served a request. This is the single biggest gap and blocks literally everything else in this doc — billing, balance, margin visibility, routing decisions, all depend on this existing first.

## 2. The foundation: a UsageEvent ledger (build this first, before anything else)

Every single AI call — chat turn, agent tool-loop step, BYOK request, everything — must write one `UsageEvent` row. This is non-negotiable groundwork; the billing page, the balance system, and the router's cost-awareness are all just *views* over this table.

```
model UsageEvent {
  id                String   @id @default(uuid())
  userId            String
  sessionId         String?          // chat/agent session this turn belongs to
  requestId         String           // provider's own request id, for support/dispute lookups
  routeId           String           // which AIProviderRoute served this (see §4)
  model             String           // e.g. "claude-fable-5", "claude-sonnet-4-5"
  provider          String           // "anthropic" | "vercel-gateway" | "byok:<providerId>"

  inputTokens       Int
  outputTokens      Int
  cacheCreationTokens Int   @default(0)
  cacheReadTokens     Int   @default(0)

  faceValueUsd      Decimal          // cost at official vendor list price — this is what's deducted from the user's credit balance
  actualCostUsd     Decimal          // cost at whatever our real route actually charged us — internal only, drives margin reporting
  marginUsd         Decimal          // faceValueUsd - actualCostUsd, denormalized for fast aggregation

  latencyMs         Int
  success           Boolean
  errorMessage      String?

  createdAt         DateTime @default(now())

  @@index([userId, createdAt])
  @@index([routeId, createdAt])
}
```

### 2.1 How to make the $ figure ~100% accurate

The honest answer from research: you cannot beat *exact* token counts, and you should not estimate them. Every Anthropic response already returns the ground truth in its `usage` object:

```
usage: {
  input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens
}
```

So accuracy is a two-part problem, not a hard research problem:

1. **Capture, don't estimate.** Read `usage` off every single response (streaming included — the final chunk carries it) and persist it verbatim. Never fall back to a tokenizer-based estimate except as a last-resort alarm ("this response had no usage block, something's wrong upstream") — estimates should trigger an alert, not silently become the billed number.
2. **Price it with a canonical, versioned rate table**, not hardcoded numbers scattered in code:

```
model ModelPriceRate {
  id                String   @id @default(uuid())
  model             String   // "claude-fable-5"
  effectiveFrom     DateTime
  inputPerMTok      Decimal  // e.g. 10.00
  outputPerMTok     Decimal  // e.g. 50.00
  cacheWritePerMTok Decimal  // 5m-write rate, e.g. 12.50
  cacheReadPerMTok  Decimal  // e.g. 1.00
}
```
   `faceValueUsd` for a `UsageEvent` = look up the rate effective at `createdAt` (not "current" rate — vendor prices change, and a rate change must never retroactively reprice historical events) and apply it to the four token buckets. This is the number the *user* sees deducted from their balance — it should track official Anthropic pricing 1:1, so users can verify it against Anthropic's own published rates and trust it.
3. **`actualCostUsd` is a separate calculation**, driven by which `AIProviderRoute` actually served the request (see §4) — each route carries its own `costMultiplier` against the same official rate table. This is what tells you real margin; it is never shown to the end user, only in the admin Billing page.
4. **Reconcile monthly against the supplier's own invoice/dashboard.** Whatever aggregator sits behind the discounted routes may round differently or apply its own fees — don't assume your computed `actualCostUsd` is gospel, cross-check it against their statement once a month and adjust `costMultiplier` if drift shows up. Flag this as a recurring admin task, not a one-time setup step.
5. **Streaming edge case:** if a stream is aborted mid-response (user cancels, connection drops), some providers still bill partial output tokens. Always read whatever partial `usage` is available even on abort/error paths — don't skip metering just because the turn didn't "complete" cleanly, or usage silently leaks unbilled.

## 3. Credit balance & billing

### 3.1 PlanConfig — the repricing lever (NEW, load-bearing)

Plans must NOT live in `common.ts` — they need to be DB rows the admin edits live:

```
model PlanConfig {
  id                String   @id @default(uuid())
  featureName       String   @unique  // "free_plan_v1" | "starter_plan_v1" | ...
  displayName       String            // "Free" | "Starter" | "Pro" | "Power" | "Studio"
  priceNaira        Int               // monthly price in ₦ (0 = free tier)
  priceUsd          Decimal?          // optional USD price for non-NGN markets
  aiCreditAllowance Decimal           // Entry Credits granted per month
  shownMultiplier   Decimal           // advertised value multiple, e.g. 3.4
  blobLimitMb       Int
  storageQuotaGb    Int
  allowedModels     String[]          // model access gate (e.g. no Fable 5 on Free)
  rolloverCredits   Boolean @default(false)
  active            Boolean @default(true)
  updatedAt         DateTime @updatedAt
}
```

Supplier dies at 2am → owner opens Admin Plans tab → cuts `aiCreditAllowance` → saves → every new grant uses the new number. Existing balances are honored (never retroactively reprice). `common.ts` becomes a read-only seed; the source of truth is this table.

### 3.2 Balance & transaction ledger

```
model UserCreditBalance {
  userId          String   @id
  balanceUsd      Decimal  @default(0)
  lastGrantedAt   DateTime?
  updatedAt       DateTime @updatedAt
}

model CreditTransaction {
  id              String   @id @default(uuid())
  userId          String
  type            String   // "subscription_grant" | "topup_fiat" | "topup_crypto" | "usage" | "refund" | "admin_adjustment" | "expiry"
  amountUsd       Decimal  // positive = credit added, negative = spent
  balanceAfterUsd Decimal  // denormalized running balance, fast history rendering without re-summing
  relatedUsageEventId String?
  relatedPaymentId    String?  // gateway/crypto tx reference once wired
  note            String?
  createdAt       DateTime @default(now())

  @@index([userId, createdAt])
}
```

Flow:
- On subscription renewal (or first activation), a workflow/cron grants that plan's `aiCreditAllowance` as a `subscription_grant` transaction and bumps `balanceUsd`.
- Every `UsageEvent` immediately writes a matching `usage` transaction for `-faceValueUsd`, atomically in the same DB transaction as the balance decrement — no async drift between "what happened" and "what the user was charged."
- Pay-as-you-go top-ups (Nigerian gateway, crypto once wired) create `topup_fiat` / `topup_crypto` transactions.
- Low-balance handling: warn at a threshold (e.g. balance < $2), hard-stop new AI turns at $0 unless the plan explicitly allows a small overdraft grace — surfaced clearly in-product, not a silent 402.
- User-facing: a "Usage & Billing" section in Settings shows current balance, a running transaction history, and a simple per-model spend breakdown for the current period.

## 4. Multi-base-URL / multi-key auto-routing (the Vercel AI Gateway replacement)

This is the same problem LiteLLM's Router, Portkey's Gateway, and OpenRouter all solve — worth building on the same shape rather than inventing a new one, since it's well-trodden:

```
model AIProviderRoute {
  id              String   @id @default(uuid())
  label           String           // "Anthropic Direct", "Discount Reseller A", "Discount Reseller B"
  baseUrl         String
  encryptedApiKey String
  compatibility   String           // "ANTHROPIC" | "OPENAI" | ...
  costMultiplier  Decimal          // 1.0 = official rate, 0.0667 = the ~15x discount deal
  allowedModels   String[]         // e.g. everything except "claude-mythos-5" for the discount route
  priority        Int              // lower = tried first among healthy routes
  weight          Int    @default(1)   // for weighted round-robin among equal-priority routes
  rpmLimit        Int?             // requests/min budget, null = no explicit cap
  tpmLimit        Int?             // tokens/min budget
  monthlySpendCapUsd Decimal?      // hard ceiling — some reseller deals are pre-paid blocks, not open-ended
  status          String  @default("healthy")  // "healthy" | "degraded" | "dead" | "disabled"
  consecutiveFailures Int @default(0)
  lastFailureAt   DateTime?
  lastUsedAt      DateTime?
  createdAt       DateTime @default(now())
}
```

Router algorithm (per request):
1. Filter routes where `status != "dead"/"disabled"`, `allowedModels` includes the requested model, and current usage is within `rpmLimit`/`tpmLimit`/`monthlySpendCapUsd`.
2. Sort candidates by `priority`, then `costMultiplier` ascending (cheapest healthy route wins by default — this is what actually captures the 15x arbitrage instead of leaving it on the table).
3. On failure (5xx, timeout, 429): mark `consecutiveFailures++`; after N (e.g. 3) in a row, flip `status: "degraded"` and skip it for a cooldown window (exponential backoff per route, not per request); retry the request against the next candidate route immediately — the *user's* request should not fail just because one upstream key is having a bad minute.
4. Health check loop (cron, e.g. every 60s): ping degraded routes with a cheap request; flip back to `healthy` on success.
5. This whole router sits behind one internal function (`routeAndCallModel(userId, model, messages, ...)`) that both the eve-root path and the BYOK direct-chat path call — neither call site should know or care which base URL/key actually served it. That's exactly what makes swapping "which reseller we use this month" a config change, not a code change.

This is also a bigger conceptual replacement of Vercel AI Gateway than it might sound — Gateway gives per-request provider fallback today, but has no concept of "route B is secretly 15x cheaper than route A for the same model," because Gateway assumes you're paying list price everywhere. Our own router is the only place that arbitrage can live.

## 4.5 Pre-flight gate & kill switch (NEW — sits in front of the router)

Before `routeAndCallModel()` picks a route, a gate runs. This stops a runaway agent loop from draining a whale's credit or blowing through the supplier's prepaid block:

1. **Balance check:** reject if balance <= 0 (unless plan allows a small overdraft grace). Return a clear in-product "out of credit — top up" state, never a silent 402.
2. **Reserve-then-settle for agent runs:** estimate a turn's likely cost up front, reserve it, settle actual on finish (refund the difference). Prevents a 40-step agent loop running 39 steps past a zero balance.
3. **Per-user daily spend cap:** configurable ceiling so one compromised/abusive account can't burn a month of supply in an hour.
4. **GLOBAL KILL SWITCH:** one admin toggle that pauses ALL paid routes instantly (BYOK still works — it's the user's own key). The "supplier key just got revoked" panic button. Lives in the Provider Routes tab; router checks it first, cached, negligible latency.

## 5. Admin page — full scope

Existing tabs (already live): **Users**, **Versions**.

New tabs to add:

1. **Billing** — the analysis page from the ask. Per-user table: plan, current balance, lifetime spend (face value), lifetime margin (internal), usage trend chart, model breakdown (which models each user actually uses and at what cost), date-range filter, CSV export. Aggregate cards at the top: total MRR, total face-value spend this period, total actual cost this period, blended margin %.
2. **Provider Routes** — CRUD over `AIProviderRoute`: add a new base URL + key, set cost multiplier/priority/spend cap, see live health status, requests served, spend-to-date against `monthlySpendCapUsd`, manual "disable this route now" kill switch for when a reseller deal goes bad.
3. **Plans** — edit the 5 `FeatureConfigs` plan entries (name, price, `aiCreditAllowance`, quotas) from the UI instead of a code deploy + redeploy cycle.
4. **Usage Events** — raw searchable/filterable log of `UsageEvent` rows (by user, model, route, date range, success/failure) — the "nothing left out" ask, literally.
5. **Diagnostics** — migrate the existing bearer-token-only routes (`errors`, `diag-sandbox`, `diag-chat`, `diag-list-byok`, `browser-sessions`) to *also* accept session + `featureService.isAdmin`, same as Users/Versions/Billing. Right now those are CLI/curl-only because they were built before a real admin UI existed; now that one exists, there's no reason an admin should need to paste a raw debug token from a terminal to see them. Keep the bearer path too, for scripted/CI use — just stop making it the *only* path.
6. **Audit Log** — every admin action (ban, enable, feature grant/revoke, credit adjustment, route disable, plan price change) writes an `AdminAuditLog` row (`adminUserId`, `action`, `targetType`, `targetId`, `before`, `after`, `createdAt`). "Control everything" should be paired with "know exactly who changed what, when" — this is standard practice for anything touching money or access, not optional polish.

## 6. Rollout order (do not build out of order — each phase is load-bearing for the next)

1. **UsageEvent metering** — capture every AI call's real token usage + computed cost, for every route currently in use (even before the router exists — just log against the single current path). Ships zero user-visible change; pure instrumentation.
2. **Credit ledger + balance** — wire plan `aiCreditAllowance` grants and start decrementing balance from `UsageEvent`s. Ship balance display in Settings.
3. **Admin Billing + Usage Events tabs** — now that data exists, expose it.
4. **Multi-key router** — build `AIProviderRoute` + `routeAndCallModel`, cut traffic over from direct Gateway calls, keep Gateway as one more configured route during transition rather than a hard cutover.
5. **Admin Provider Routes + Plans tabs.**
6. **Payment gateway wiring** (Moniepoint/Monnify + crypto, once the payment PDF lands) — feeds `CreditTransaction.topup_*` via webhooks: verify signature, re-query gateway for amount, idempotent by tx reference.
7. **Diagnostics tab migration + Audit Log** — good practice, lowest urgency, do last.

## 7. Open risks worth flagging now, not after

- Reseller/aggregator API keys reselling official vendor capacity at a steep discount usually sit in a ToS gray zone — worth the owner's own eyes-open call, not something to route around silently.
- Don't retroactively reprice: a `ModelPriceRate` change must never touch historical `UsageEvent.faceValueUsd` — otherwise a user's past statement changes underneath them.
- `monthlySpendCapUsd` on discount routes should alert well before it's hit (e.g. 80%), not fail silently at 100% mid-request.
- Streaming abort/error paths must still capture partial usage — the most common way a metering system quietly under-bills.

## 8. Architecture sketch

![Admin/billing/routing architecture sketch](/admin-architecture-sketch.png)

`routeAndCallModel()` sits between every caller (eve-root agent path and the
BYOK direct-chat path both call it) and the pool of `AIProviderRoute`s. Every
call writes one `UsageEvent` row regardless of which route served it.
`UserCreditBalance` + `CreditTransaction` and the admin Billing/Analysis page
are both just readers of that same event stream -- neither one is a separate
source of truth, so they can never drift out of sync with each other.

## 9. Process note: admin-page work does not go in the changelog

`apps/web/lib/changelog.ts` is user-facing product changelog -- it's meant to
tell *users* what changed for *them* (new features, fixes to things they'd
notice). Admin-page work (this whole doc) is internal tooling for the owner
only and must never be logged there. Continue recording admin/internal work
as an `AppVersion` row (via `POST /api/admin/versions`, see the Versions tab)
for rollback purposes -- that's a separate, correct place for it -- just never
in `changelog.ts`.
