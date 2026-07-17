-- AlterTable
ALTER TABLE "chat_browser_sessions" ADD COLUMN "steps" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "chat_browser_sessions" ADD COLUMN "recording_url" VARCHAR;
