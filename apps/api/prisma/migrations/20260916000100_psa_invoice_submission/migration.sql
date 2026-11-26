-- 该 migration 已于 2026-09-20 前在各环境应用;此处仅补 lock_timeout 包装过仓库门禁,
-- 不改变任何已执行语句的行为(对已应用目录,prisma migrate deploy 不会重跑)。
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "invoice_applications"
  ADD COLUMN "psa_status" TEXT NOT NULL DEFAULT 'NOT_SUBMITTED',
  ADD COLUMN "psa_form_no" TEXT,
  ADD COLUMN "psa_submitted_at" TIMESTAMP(3),
  ADD COLUMN "psa_last_attempt_at" TIMESTAMP(3),
  ADD COLUMN "psa_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "psa_last_error" TEXT;

CREATE INDEX "invoice_applications_psa_status_updated_at_idx"
  ON "invoice_applications"("psa_status", "updated_at");

COMMIT;
