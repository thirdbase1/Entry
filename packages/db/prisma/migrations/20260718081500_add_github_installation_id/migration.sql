-- Stores the GitHub App installationId a user's Vercel Connect GitHub grant
-- resolved to. GitHub is a multi-tenant connector (installation is a
-- separate axis from subject) -- see connect-service-tokens.ts.
ALTER TABLE "users" ADD COLUMN "github_installation_id" VARCHAR;
