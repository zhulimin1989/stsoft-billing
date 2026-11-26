-- 议题二 批一：企业开通回收的持久屏障与 fanout 作业表
-- 设计依据：me/payg-multiplier-verify-timeout-v2.md v68 §2.2b（唯一真源）
--
-- M1 墓碑（权威屏障，verification 级）：必须能在「账户尚未存在」时也挡住迟到的 create。
-- M2 账户行级派生缓存：供已持有账户行的热写点做 O(1) 检查。
-- M3 提交后 fanout 作业表：缓存同步/key 投影重算的至少一次投递。

-- ── M1 ────────────────────────────────────────────────────────────────────────
CREATE TABLE "enterprise_provisioning_tombstones" (
  "verification_id" TEXT NOT NULL,
  "reason"          TEXT NOT NULL,
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "enterprise_provisioning_tombstones_pkey" PRIMARY KEY ("verification_id")
);

-- ── M2 ────────────────────────────────────────────────────────────────────────
-- 单调列：只由 void-provisioning 以 COALESCE(..., now()) 置一次；批一无任何清除路径。
ALTER TABLE "billing_accounts"
  ADD COLUMN "provisioning_quarantined_at" TIMESTAMPTZ(3);

CREATE INDEX "billing_accounts_provisioning_quarantined_at_idx"
  ON "billing_accounts" ("provisioning_quarantined_at")
  WHERE "provisioning_quarantined_at" IS NOT NULL;

-- ── M3 ────────────────────────────────────────────────────────────────────────
CREATE TABLE "enterprise_recovery_fanout_jobs" (
  "id"              TEXT NOT NULL,
  "verification_id" TEXT NOT NULL,
  "kind"            TEXT NOT NULL,
  "account_id"      TEXT,
  "tenant_id"       TEXT,
  "api_key_id"      TEXT,
  "status"          TEXT NOT NULL DEFAULT 'PENDING',
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "max_attempts"    INTEGER NOT NULL DEFAULT 8,
  "next_run_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at"       TIMESTAMPTZ(3),
  "lease_token"     TEXT,
  "last_error"      TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "enterprise_recovery_fanout_jobs_pkey" PRIMARY KEY ("id"),
  -- 三态：PENDING 可领取 / DONE 成功保留 / ALERTED 达上限不可领取（人工复位）
  CONSTRAINT "erfj_status_chk" CHECK ("status" IN ('PENDING', 'DONE', 'ALERTED')),
  -- 每种 kind 恰有一个资源列非空：避免 coalesce 选错列造成隐式键碰撞
  CONSTRAINT "erfj_kind_resource_chk" CHECK (
    ("kind" = 'KEY_BY_ID'    AND "api_key_id" IS NOT NULL AND "tenant_id" IS NULL     AND "account_id" IS NULL)
    OR ("kind" = 'TENANT_CACHE' AND "tenant_id" IS NOT NULL AND "api_key_id" IS NULL  AND "account_id" IS NULL)
    OR ("kind" = 'ACCOUNT'      AND "account_id" IS NOT NULL AND "api_key_id" IS NULL AND "tenant_id" IS NULL)
  )
);

-- 稳定事件键必须含 verification_id 与 kind：否则 DONE 行会永久占键，
-- 同一 tenant/api key 在「另一次回收」中无法重新入队（修复被静默跳过）。
CREATE UNIQUE INDEX "enterprise_recovery_fanout_jobs_idempotency_key_key"
  ON "enterprise_recovery_fanout_jobs" ("idempotency_key");
CREATE INDEX "enterprise_recovery_fanout_jobs_status_next_run_at_idx"
  ON "enterprise_recovery_fanout_jobs" ("status", "next_run_at");
CREATE INDEX "enterprise_recovery_fanout_jobs_verification_id_idx"
  ON "enterprise_recovery_fanout_jobs" ("verification_id");
