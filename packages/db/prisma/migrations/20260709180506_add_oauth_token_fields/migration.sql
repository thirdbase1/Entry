-- AlterTable
ALTER TABLE "user_accounts" ADD COLUMN     "access_token_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "id_token" TEXT,
ADD COLUMN     "refresh_token_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "scope" TEXT;
