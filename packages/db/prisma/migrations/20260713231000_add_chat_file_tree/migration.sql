-- CreateTable
CREATE TABLE "chat_file_trees" (
    "chat_id" VARCHAR NOT NULL,
    "tree_json" TEXT NOT NULL,
    "root_label" VARCHAR,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_file_trees_pkey" PRIMARY KEY ("chat_id")
);
