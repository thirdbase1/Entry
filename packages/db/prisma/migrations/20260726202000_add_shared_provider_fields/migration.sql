-- Shared/platform-provided BYOK-style providers (owner ask 2026-07-26):
-- a relay key that costs the platform real money and is capped per-row.
ALTER TABLE "user_model_providers"
  ADD COLUMN "is_shared" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "spend_cap_usd" DECIMAL(10,2);
