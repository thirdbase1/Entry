-- Dedicated reasoning-test result columns, separate from the existing
-- plain-connectivity lastTestStatus/lastTestError -- see
-- UserModelProviderModel.lastReasoningTestStatus's schema comment for why.
ALTER TABLE "user_model_provider_models" ADD COLUMN "last_reasoning_tested_at" TIMESTAMPTZ(3);
ALTER TABLE "user_model_provider_models" ADD COLUMN "last_reasoning_test_status" VARCHAR;
ALTER TABLE "user_model_provider_models" ADD COLUMN "last_reasoning_test_error" TEXT;
ALTER TABLE "user_model_provider_models" ADD COLUMN "last_reasoning_tokens" INTEGER;
