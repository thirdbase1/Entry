-- CreateTable
CREATE TABLE "chat_sandboxes" (
    "chat_id" VARCHAR NOT NULL,
    "sandbox_id" VARCHAR NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_sandboxes_pkey" PRIMARY KEY ("chat_id")
);
