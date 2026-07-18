-- CreateTable
CREATE TABLE "user_working_memory" (
    "user_id" VARCHAR NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_working_memory_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "user_working_memory" ADD CONSTRAINT "user_working_memory_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
