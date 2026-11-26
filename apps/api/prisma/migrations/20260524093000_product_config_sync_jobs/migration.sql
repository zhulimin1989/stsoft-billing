CREATE TABLE IF NOT EXISTS "product_config_sync_jobs" (
  "id" TEXT NOT NULL,
  "product_id" TEXT,
  "product_slug" TEXT NOT NULL,
  "change_type" TEXT NOT NULL,
  "payload" JSONB,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 8,
  "idempotency_key" TEXT NOT NULL,
  "source" TEXT,
  "resource_type" TEXT,
  "resource_id" TEXT,
  "last_error" TEXT,
  "response" JSONB,
  "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "processed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "product_config_sync_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_config_sync_jobs_idempotency_key_key"
  ON "product_config_sync_jobs"("idempotency_key");

CREATE INDEX IF NOT EXISTS "product_config_sync_jobs_status_next_run_at_idx"
  ON "product_config_sync_jobs"("status", "next_run_at");

CREATE INDEX IF NOT EXISTS "product_config_sync_jobs_product_slug_status_idx"
  ON "product_config_sync_jobs"("product_slug", "status");

CREATE INDEX IF NOT EXISTS "product_config_sync_jobs_resource_type_resource_id_idx"
  ON "product_config_sync_jobs"("resource_type", "resource_id");

CREATE INDEX IF NOT EXISTS "product_config_sync_jobs_created_at_idx"
  ON "product_config_sync_jobs"("created_at");
