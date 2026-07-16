-- CreateTable
CREATE TABLE "chat_versions" (
    "id" TEXT NOT NULL,
    "chat_id" VARCHAR NOT NULL,
    "version_number" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "files_changed" INTEGER NOT NULL,
    "lines_added" INTEGER NOT NULL,
    "lines_removed" INTEGER NOT NULL,
    "reverted_from_version_number" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_version_files" (
    "id" TEXT NOT NULL,
    "chat_id" VARCHAR NOT NULL,
    "version_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "path" VARCHAR NOT NULL,
    "change_type" VARCHAR NOT NULL,
    "content" TEXT,
    "lines_added" INTEGER NOT NULL,
    "lines_removed" INTEGER NOT NULL,

    CONSTRAINT "chat_version_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_versions_chat_id_created_at_idx" ON "chat_versions"("chat_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_versions_chat_id_version_number_key" ON "chat_versions"("chat_id", "version_number");

-- CreateIndex
CREATE INDEX "chat_version_files_chat_id_path_version_number_idx" ON "chat_version_files"("chat_id", "path", "version_number");

-- CreateIndex
CREATE INDEX "chat_version_files_version_id_idx" ON "chat_version_files"("version_id");
