CREATE TABLE "finance_export_jobs" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "tab" TEXT NOT NULL,
    "billing_mode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL DEFAULT 'text/csv; charset=utf-8',
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "file_content" TEXT,
    "error_message" TEXT,
    "requested_by_admin_id" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_export_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "finance_export_jobs_status_created_at_idx" ON "finance_export_jobs"("status", "created_at");
CREATE INDEX "finance_export_jobs_requested_by_admin_id_created_at_idx" ON "finance_export_jobs"("requested_by_admin_id", "created_at");
CREATE INDEX "finance_export_jobs_expires_at_idx" ON "finance_export_jobs"("expires_at");
