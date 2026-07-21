-- Background handoff flag: true while a Trigger.dev durable worker run
-- is actively continuing a chat's turn past the sync route's 300s ceiling.
ALTER TABLE "eve_chat_sessions" ADD COLUMN "background_run_active" BOOLEAN NOT NULL DEFAULT false;
