-- AlterTable: mark an eve_chat_sessions row as BYOK-direct (see EveChatSession
-- model comment in schema.prisma) — nullable, additive, zero-downtime.
ALTER TABLE "eve_chat_sessions" ADD COLUMN "byok_model_id" VARCHAR;
