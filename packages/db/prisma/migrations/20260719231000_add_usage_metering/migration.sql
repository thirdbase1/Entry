-- Phase 1 of admin.md: usage metering foundation (see schema comments).
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "user_id" VARCHAR NOT NULL,
    "chat_id" VARCHAR,
    "source" VARCHAR NOT NULL,
    "model" VARCHAR NOT NULL,
    "provider" VARCHAR NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cache_creation_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "face_value_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "actual_cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "price_rate_id" TEXT,
    "finish_reason" VARCHAR,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "usage_events_user_id_created_at_idx" ON "usage_events"("user_id", "created_at");
CREATE INDEX "usage_events_model_created_at_idx" ON "usage_events"("model", "created_at");

CREATE TABLE "model_price_rates" (
    "id" TEXT NOT NULL,
    "model_pattern" VARCHAR NOT NULL,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "input_per_mtok" DECIMAL(10,4) NOT NULL,
    "output_per_mtok" DECIMAL(10,4) NOT NULL,
    "cache_write_per_mtok" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "cache_read_per_mtok" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "model_price_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "model_price_rates_model_pattern_effective_from_idx" ON "model_price_rates"("model_pattern", "effective_from");

-- Seed official Anthropic list prices (per MTok, published rates as of
-- 2026-07). faceValueUsd tracks OFFICIAL vendor pricing 1:1 (admin.md
-- §2.1) so users can verify their burn against Anthropic's own page.
-- New/changed vendor prices = INSERT a new row with a later
-- effective_from, never UPDATE these.
INSERT INTO "model_price_rates" ("id", "model_pattern", "effective_from", "input_per_mtok", "output_per_mtok", "cache_write_per_mtok", "cache_read_per_mtok") VALUES
  ('seed-fable-5',      'claude-fable-5',      '2026-01-01T00:00:00Z', 10.00, 50.00, 12.50, 1.00),
  ('seed-opus-4',       'claude-opus-4',       '2026-01-01T00:00:00Z', 15.00, 75.00, 18.75, 1.50),
  ('seed-sonnet-4-5',   'claude-sonnet-4-5',   '2026-01-01T00:00:00Z',  3.00, 15.00,  3.75, 0.30),
  ('seed-sonnet-4',     'claude-sonnet-4',     '2026-01-01T00:00:00Z',  3.00, 15.00,  3.75, 0.30),
  ('seed-haiku-4',      'claude-haiku-4',      '2026-01-01T00:00:00Z',  1.00,  5.00,  1.25, 0.10);
