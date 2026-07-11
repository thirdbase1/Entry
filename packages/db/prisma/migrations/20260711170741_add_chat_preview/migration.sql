-- CreateTable
CREATE TABLE "chat_previews" (
    "chat_id" VARCHAR NOT NULL,
    "url" VARCHAR,
    "port" INTEGER,
    "status" VARCHAR NOT NULL DEFAULT 'stopped',
    "error_message" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_previews_pkey" PRIMARY KEY ("chat_id")
);
