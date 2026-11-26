-- 自营连续订阅（连续包月/季/年自动续费）P0 地基：合约 + 每期扣款 + 首月优惠资格 + 回调去重。
-- 仅自营 platform_model_package；不动转售/通用订阅/财务。

-- Enums
CREATE TYPE "CodingPlanAutoRenewalStatus" AS ENUM (
  'SIGNING', 'PENDING_FIRST_CHARGE', 'FIRST_CHARGE_FAILED', 'ACTIVE', 'PAST_DUE',
  'CANCEL_PENDING', 'CANCELLED', 'EXPIRED', 'SUSPENDED', 'PENDING_SWITCH', 'SWITCHED_OUT'
);
CREATE TYPE "CodingPlanRenewalChargeType" AS ENUM ('FIRST', 'RENEWAL', 'SWITCH');
CREATE TYPE "CodingPlanRenewalChargeStatus" AS ENUM (
  'INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'LATE_SUCCESS_NEEDS_REFUND'
);

-- 合约表
CREATE TABLE "coding_plan_auto_renewals" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "plan_id" TEXT NOT NULL,
  "billing_period" TEXT NOT NULL DEFAULT 'monthly',
  "channel" "PayChannel" NOT NULL,
  "status" "CodingPlanAutoRenewalStatus" NOT NULL DEFAULT 'SIGNING',
  "contract_no" TEXT NOT NULL,
  "external_agreement_no" TEXT,
  "first_month_amount_cents" INTEGER NOT NULL,
  "first_period_amount_cents" INTEGER NOT NULL,
  "list_amount_cents" INTEGER,
  "discount_amount_cents" INTEGER,
  "promotion_id" TEXT,
  "currency" TEXT NOT NULL,
  "next_charge_at" TIMESTAMP(3),
  "current_entitlement_id" TEXT,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "cancel_requested_at" TIMESTAMP(3),
  "cancel_effective_at" TIMESTAMP(3),
  "renewal_disabled_at" TIMESTAMP(3),
  "renewal_blocked_reason" TEXT,
  "switching_out_to_contract_id" TEXT,
  "source_contract_id" TEXT,
  "source_entitlement_id" TEXT,
  "agreement_terminate_status" TEXT,
  "terminate_retry_at" TIMESTAMP(3),
  "terminate_last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "coding_plan_auto_renewals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "coding_plan_auto_renewals_contract_no_key" ON "coding_plan_auto_renewals" ("contract_no");
CREATE UNIQUE INDEX "coding_plan_auto_renewals_external_agreement_no_key" ON "coding_plan_auto_renewals" ("external_agreement_no");
CREATE INDEX "coding_plan_auto_renewals_user_id_idx" ON "coding_plan_auto_renewals" ("user_id");
CREATE INDEX "coding_plan_auto_renewals_tenant_id_product_id_idx" ON "coding_plan_auto_renewals" ("tenant_id", "product_id");
CREATE INDEX "coding_plan_auto_renewals_status_idx" ON "coding_plan_auto_renewals" ("status");
CREATE INDEX "coding_plan_auto_renewals_source_contract_id_idx" ON "coding_plan_auto_renewals" ("source_contract_id");
-- 单一活跃合约：每 tenant+product 至多一条「在用」合约（ACTIVE/PAST_DUE/CANCEL_PENDING/SUSPENDED 均占槽）；
-- 切换中新约 PENDING_SWITCH 及签约态 SIGNING/PENDING_FIRST_CHARGE 不占槽（允许切换期间新旧并存）。
CREATE UNIQUE INDEX "uniq_active_auto_renewal"
  ON "coding_plan_auto_renewals" ("tenant_id", "product_id")
  WHERE "status" IN ('ACTIVE', 'PAST_DUE', 'CANCEL_PENDING', 'SUSPENDED');
-- 同一来源合约至多一个未完成切换单（防并发重复切换）。
CREATE UNIQUE INDEX "uniq_pending_switch_per_source"
  ON "coding_plan_auto_renewals" ("source_contract_id")
  WHERE "status" = 'PENDING_SWITCH';
-- 续期 cron 扫描：仅在用且有下次扣款日的行。
CREATE INDEX "idx_auto_renewal_due"
  ON "coding_plan_auto_renewals" ("next_charge_at")
  WHERE "next_charge_at" IS NOT NULL AND "status" IN ('ACTIVE', 'PAST_DUE');

-- 每期扣款尝试
CREATE TABLE "coding_plan_renewal_charges" (
  "id" TEXT NOT NULL,
  "auto_renewal_id" TEXT NOT NULL,
  "period_start" TIMESTAMP(3) NOT NULL,
  "period_end" TIMESTAMP(3) NOT NULL,
  "period_key" TEXT NOT NULL,
  "charge_type" "CodingPlanRenewalChargeType" NOT NULL DEFAULT 'RENEWAL',
  "status" "CodingPlanRenewalChargeStatus" NOT NULL DEFAULT 'INITIATED',
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "order_id" TEXT,
  "external_trade_no" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "coding_plan_renewal_charges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "coding_plan_renewal_charges_external_trade_no_key" ON "coding_plan_renewal_charges" ("external_trade_no");
CREATE UNIQUE INDEX "uniq_renewal_charge_period" ON "coding_plan_renewal_charges" ("auto_renewal_id", "period_start", "period_end", "charge_type");
CREATE INDEX "coding_plan_renewal_charges_auto_renewal_id_idx" ON "coding_plan_renewal_charges" ("auto_renewal_id");
CREATE INDEX "coding_plan_renewal_charges_status_idx" ON "coding_plan_renewal_charges" ("status");
ALTER TABLE "coding_plan_renewal_charges"
  ADD CONSTRAINT "coding_plan_renewal_charges_auto_renewal_id_fkey"
  FOREIGN KEY ("auto_renewal_id") REFERENCES "coding_plan_auto_renewals" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 首月优惠资格持久化
CREATE TABLE "coding_plan_promo_grants" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "product_line" TEXT NOT NULL,
  "promotion_id" TEXT,
  "consumed_by_order_id" TEXT,
  "consumed_amount_cents" INTEGER,
  "currency" TEXT,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coding_plan_promo_grants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uniq_promo_grant_line" ON "coding_plan_promo_grants" ("user_id", "tenant_id", "product_line");
CREATE INDEX "coding_plan_promo_grants_user_id_idx" ON "coding_plan_promo_grants" ("user_id");

-- 回调事件去重
CREATE TABLE "coding_plan_renewal_events" (
  "id" TEXT NOT NULL,
  "channel" "PayChannel" NOT NULL,
  "external_event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coding_plan_renewal_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uniq_renewal_event" ON "coding_plan_renewal_events" ("channel", "external_event_id");
