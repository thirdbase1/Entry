-- CreateTable
CREATE TABLE "app_versions" (
    "id" TEXT NOT NULL,
    "label" VARCHAR(500) NOT NULL,
    "vercel_deployment_id" VARCHAR NOT NULL,
    "vercel_url" VARCHAR,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_versions_pkey" PRIMARY KEY ("id")
);
