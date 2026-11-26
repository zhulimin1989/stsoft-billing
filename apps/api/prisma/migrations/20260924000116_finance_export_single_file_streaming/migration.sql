BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "finance_export_jobs"
  ADD COLUMN "file_path" TEXT,
  ADD COLUMN "file_size_bytes" BIGINT,
  ADD COLUMN "file_sha256" TEXT,
  ADD COLUMN "processed_rows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "total_rows" INTEGER,
  ADD COLUMN "as_of" TIMESTAMP(3),
  ADD COLUMN "heartbeat_at" TIMESTAMP(3),
  ADD COLUMN "error_code" TEXT,
  ADD COLUMN "failed_stage" TEXT;

COMMIT;
