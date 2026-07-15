-- AlterTable
-- "Test connection" result columns for BYOK models (settings page,
-- 2026-07-15): lets a user fire a minimal real completion at a saved
-- model and persist the result, so the green/red status survives a page
-- reload instead of resetting to "untested" every visit.
ALTER TABLE "user_model_provider_models"
  ADD COLUMN "last_tested_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_test_status" VARCHAR,
  ADD COLUMN "last_test_error" TEXT;
