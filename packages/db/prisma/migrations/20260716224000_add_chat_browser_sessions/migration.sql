-- CreateTable
CREATE TABLE "chat_browser_sessions" (
    "id" VARCHAR NOT NULL,
    "chat_id" VARCHAR NOT NULL,
    "provider" VARCHAR NOT NULL DEFAULT 'browser_use',
    "slot" INTEGER NOT NULL,
    "provider_session_id" VARCHAR NOT NULL,
    "metadata" JSONB,
    "task" TEXT NOT NULL,
    "status" VARCHAR NOT NULL DEFAULT 'running',
    "live_url" VARCHAR,
    "output" TEXT,
    "is_task_successful" BOOLEAN,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_browser_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_browser_sessions_chat_id_idx" ON "chat_browser_sessions"("chat_id");
