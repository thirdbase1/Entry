-- Drop background_run_active / background_run_id: dead columns left over
-- from a removed Trigger.dev-based long-turn-continuation subsystem
-- (agent-chat-turn-orchestrator, /realtime-token route -- confirmed
-- gone from the codebase, zero references anywhere). Nothing has ever
-- written these two columns since that removal; the only reader
-- (admin/diag-chat) has been updated to stop referencing them. Long
-- task handling today is entirely the heartbeat-renewed Redis turn-lock
-- + resumable stream mirror in direct-chat/turn-lock.ts, which needs no
-- DB-level bookkeeping of its own.
ALTER TABLE "eve_chat_sessions" DROP COLUMN IF EXISTS "background_run_active";
ALTER TABLE "eve_chat_sessions" DROP COLUMN IF EXISTS "background_run_id";
