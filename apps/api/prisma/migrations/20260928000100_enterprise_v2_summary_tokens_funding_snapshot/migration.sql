-- 当月汇总补用量列；列表未结清改读账户一行快照。
-- ALTER 取 ACCESS EXCLUSIVE，必须限制等锁时间。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "enterprise_bill_month_summaries"
  ADD COLUMN IF NOT EXISTS "token_total" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "request_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "enterprise_funding_snapshots" (
  "billing_account_id" TEXT NOT NULL,
  "approved_receivable_usd" DECIMAL(20,12) NOT NULL,
  "unapproved_debt_usd" DECIMAL(20,12) NOT NULL,
  "classification_complete" BOOLEAN NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "enterprise_funding_snapshots_pkey" PRIMARY KEY ("billing_account_id")
);

ALTER TABLE "enterprise_funding_snapshots"
  DROP CONSTRAINT IF EXISTS "enterprise_funding_snapshots_billing_account_id_fkey";
ALTER TABLE "enterprise_funding_snapshots"
  ADD CONSTRAINT "enterprise_funding_snapshots_billing_account_id_fkey"
  FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
