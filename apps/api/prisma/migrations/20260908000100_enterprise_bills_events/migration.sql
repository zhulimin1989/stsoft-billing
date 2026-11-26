-- 企业账单：闭月账期冻结（含金额定格快照）+ 核销/调整/延期事件（含状态机）。
-- 不改 billing_accounts 列，消耗仍按北京时间自然月现算。
-- 迟到用量不回写已定格列，由服务层 spill 进未定格月。
-- 事件 status 状态值：'PENDING' | 'CONFIRMED' | 'FAILED'（由服务层约束，非 DB 枚举）。
-- 建表/建索引需 ACCESS EXCLUSIVE 级锁，必须限制等锁时间：
-- 拿不到锁快速失败重试，避免锁队列堆积（见 scripts/check-migration-lock-timeout.mjs）。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "enterprise_bill_deadlines" (
    "id" TEXT NOT NULL,
    "billing_account_id" TEXT NOT NULL,
    "year_month" TEXT NOT NULL,
    "terms_days" INTEGER NOT NULL,
    "default_due_at" TIMESTAMP(3) NOT NULL,
    "frozen_at" TIMESTAMP(3) NOT NULL,
    "pending_at_deadline" BOOLEAN,
    "pending_observed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "frozen_consume_cents" INTEGER,
    "frozen_voucher_cents" INTEGER,
    "frozen_charge_cents" INTEGER,
    "frozen_token_total" INTEGER,
    "frozen_request_count" INTEGER,
    "amounts_frozen_at" TIMESTAMP(3),
    
    CONSTRAINT "enterprise_bill_deadlines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "enterprise_bill_deadlines_billing_account_id_year_month_key"
  ON "enterprise_bill_deadlines"("billing_account_id", "year_month");
CREATE INDEX "enterprise_bill_deadlines_billing_account_id_idx"
  ON "enterprise_bill_deadlines"("billing_account_id");
CREATE INDEX "enterprise_bill_deadlines_default_due_at_idx"
  ON "enterprise_bill_deadlines"("default_due_at");

CREATE TABLE "enterprise_bill_events" (
    "id" TEXT NOT NULL,
    "billing_account_id" TEXT NOT NULL,
    "year_month" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL DEFAULT 0,
    "due_at" TIMESTAMP(3),
    "note" TEXT,
    "actor_id" TEXT,
    "status" TEXT DEFAULT 'CONFIRMED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enterprise_bill_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "enterprise_bill_events_billing_account_id_year_month_created_at_idx"
  ON "enterprise_bill_events"("billing_account_id", "year_month", "created_at");

COMMIT;
