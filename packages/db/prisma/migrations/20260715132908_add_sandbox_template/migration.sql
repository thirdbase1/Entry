-- CreateTable
CREATE TABLE "sandbox_templates" (
    "template_key" VARCHAR NOT NULL,
    "snapshot_id" VARCHAR NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandbox_templates_pkey" PRIMARY KEY ("template_key")
);
