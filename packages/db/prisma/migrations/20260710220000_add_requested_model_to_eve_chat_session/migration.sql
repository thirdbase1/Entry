-- AlterTable: mark an eve_chat_sessions row as a direct Gateway-model chat
-- (see EveChatSession model comment in schema.prisma) — nullable, additive,
-- zero-downtime, mutually exclusive with byok_model_id.
ALTER TABLE "eve_chat_sessions" ADD COLUMN "requested_model" VARCHAR;
