-- CreateTable
CREATE TABLE "error_logs" (
    "id" TEXT NOT NULL,
    "source" VARCHAR NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "user_id" VARCHAR,
    "chat_id" VARCHAR,
    "context" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "error_logs_source_idx" ON "error_logs"("source");

-- CreateIndex
CREATE INDEX "error_logs_user_id_idx" ON "error_logs"("user_id");

-- CreateIndex
CREATE INDEX "error_logs_chat_id_idx" ON "error_logs"("chat_id");

-- CreateIndex
CREATE INDEX "error_logs_created_at_idx" ON "error_logs"("created_at");
