-- AlterEnum
-- Adds the OpenAI *Responses* API compatibility mode (input/output items,
-- not messages/choices) for BYOK connections that proxy models behind that
-- shape with a per-model-family base path -- e.g. Kie.ai's
-- `https://api.kie.ai/grok/v1` (POST {base}/responses) for Grok 4.5.
-- Postgres requires ALTER TYPE ... ADD VALUE to run outside any
-- transaction block that also uses the new value, which is exactly what a
-- plain additive migration file already is -- no data migration needed
-- since this only adds a new option to the enum.
ALTER TYPE "ByokCompatibility" ADD VALUE 'OPENAI_RESPONSES';
