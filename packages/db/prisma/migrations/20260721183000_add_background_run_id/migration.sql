-- Adds the Trigger.dev run ID for the currently-active background worker
-- run on a chat session, so the frontend can mint a scoped realtime token
-- to subscribe to that run's live chunk stream.
ALTER TABLE "eve_chat_sessions" ADD COLUMN "background_run_id" TEXT;
