-- 企业账单月汇总：账户 × 北京月一行。列表到期日 / tab 闭月金额读这张表。
-- 新表，V2 尚未进生产；建表与索引同事务即可。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "enterprise_bill_month_summaries" (
    "id" TEXT NOT NULL,
    "billing_account_id" TEXT NOT NULL,
    "year_month" TEXT NOT NULL,
    "paid_cents" INTEGER NOT NULL,
    "pending_cents" INTEGER NOT NULL,
    "adjusted_cents" INTEGER NOT NULL,
    "issued_voucher_cents" INTEGER NOT NULL,
    "consume_cents" INTEGER NOT NULL,
    "voucher_cents" INTEGER NOT NULL,
    "charge_cents" INTEGER NOT NULL,
    "effective_due_at" TIMESTAMP(3),
    "due_projected" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_bill_month_summaries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "enterprise_bill_month_summaries_billing_account_id_year_month_key"
  ON "enterprise_bill_month_summaries"("billing_account_id", "year_month");

CREATE INDEX "enterprise_bill_month_summaries_account_pending_due_idx"
  ON "enterprise_bill_month_summaries"("billing_account_id", "pending_cents", "effective_due_at");

CREATE INDEX "enterprise_bill_month_summaries_year_month_idx"
  ON "enterprise_bill_month_summaries"("year_month");

-- 列表 MIN(effective_due_at) WHERE pending_cents > 0
CREATE INDEX "enterprise_bill_month_summaries_pending_due_idx"
  ON "enterprise_bill_month_summaries"("billing_account_id", "effective_due_at")
  WHERE "pending_cents" > 0;

ALTER TABLE "enterprise_bill_month_summaries"
  ADD CONSTRAINT "enterprise_bill_month_summaries_billing_account_id_fkey"
  FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
