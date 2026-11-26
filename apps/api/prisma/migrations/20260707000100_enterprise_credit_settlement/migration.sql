-- 企业信用还款核销（见 docs/enterprise-credit.zh-CN.md）：
-- 1) balance_consumption_allocations 增加核销累计/完成时间；
-- 2) enterprise_credit_settlements 记录每笔还款↔消费分摊的核销明细（含实付/赠金拆分）。

ALTER TABLE "balance_consumption_allocations"
  ADD COLUMN IF NOT EXISTS "settled_usd" DECIMAL(20, 12) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "settled_at" TIMESTAMP(3);

-- FIFO 扫描：按账户+来源+时间取未核销的企业信用消费。
CREATE INDEX IF NOT EXISTS "balance_consumption_allocations_account_source_created_idx"
  ON "balance_consumption_allocations"("billing_account_id", "source", "created_at");

CREATE TABLE IF NOT EXISTS "enterprise_credit_settlements" (
  "id" TEXT PRIMARY KEY,
  "billing_account_id" TEXT NOT NULL,
  "allocation_id" TEXT NOT NULL,
  -- 还款对应的资金流水（充值/调整/退款）；SWEEP 兜底核销时为 NULL。
  "repayment_transaction_id" TEXT,
  -- FUNDING = 注资触发；SWEEP = 每日兜底核销（钱包已回正但分摊残留未核销）。
  "trigger" TEXT NOT NULL DEFAULT 'FUNDING',
  "amount_usd" DECIMAL(20, 12) NOT NULL,
  "paid_usd" DECIMAL(20, 12) NOT NULL DEFAULT 0,
  "bonus_usd" DECIMAL(20, 12) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "enterprise_credit_settlements_billing_account_id_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "enterprise_credit_settlements_allocation_id_fkey"
    FOREIGN KEY ("allocation_id") REFERENCES "balance_consumption_allocations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "enterprise_credit_settlements_repayment_transaction_id_fkey"
    FOREIGN KEY ("repayment_transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "enterprise_credit_settlements_account_created_idx"
  ON "enterprise_credit_settlements"("billing_account_id", "created_at");
CREATE INDEX IF NOT EXISTS "enterprise_credit_settlements_allocation_idx"
  ON "enterprise_credit_settlements"("allocation_id");
CREATE INDEX IF NOT EXISTS "enterprise_credit_settlements_repayment_tx_idx"
  ON "enterprise_credit_settlements"("repayment_transaction_id");
