-- DropForeignKey
ALTER TABLE "user_working_memory" DROP CONSTRAINT IF EXISTS "user_working_memory_user_id_fkey";

-- DropTable
-- Deliberate data loss (2026-07-23, real reversal of the 2026-07-18
-- per-user design): working memory notes are no longer shared across a
-- user's chats, so there is nothing meaningful to carry over into the new
-- per-chat table -- a note written for "the user" has no single correct
-- chat to attach it to.
DROP TABLE IF EXISTS "user_working_memory";

-- CreateTable
CREATE TABLE "chat_working_memory" (
    "chat_id" VARCHAR NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_working_memory_pkey" PRIMARY KEY ("chat_id")
);

-- AddForeignKey
ALTER TABLE "chat_working_memory" ADD CONSTRAINT "chat_working_memory_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "eve_chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
