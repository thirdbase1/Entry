-- CreateEnum
CREATE TYPE "ByokCompatibility" AS ENUM ('OPENAI', 'ANTHROPIC', 'GOOGLE');

-- CreateTable
CREATE TABLE "user_model_providers" (
    "id" VARCHAR NOT NULL,
    "user_id" VARCHAR NOT NULL,
    "label" VARCHAR NOT NULL,
    "compatibility" "ByokCompatibility" NOT NULL DEFAULT 'OPENAI',
    "base_url" VARCHAR NOT NULL,
    "encrypted_api_key" TEXT,
    "last_fetched_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_model_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_model_provider_models" (
    "id" VARCHAR NOT NULL,
    "provider_id" VARCHAR NOT NULL,
    "model_id" VARCHAR NOT NULL,
    "label" VARCHAR,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_model_provider_models_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_model_providers_user_id_idx" ON "user_model_providers"("user_id");

-- CreateIndex
CREATE INDEX "user_model_provider_models_provider_id_idx" ON "user_model_provider_models"("provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_model_provider_models_provider_id_model_id_key" ON "user_model_provider_models"("provider_id", "model_id");

-- AddForeignKey
ALTER TABLE "user_model_providers" ADD CONSTRAINT "user_model_providers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_model_provider_models" ADD CONSTRAINT "user_model_provider_models_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "user_model_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
