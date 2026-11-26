-- 待核销欠款队列。设计说明见 schema.prisma 的 BalanceDebtSettlementPending。
--
-- 不变量:Σ(未结欠款) - Σ(pending.remaining) = max(0, -wallet)
-- 由应用在同一事务内维护(充值写入 / worker 递减),并由
-- assertReconciledBalanceLedgerSnapshot 的三项式在每次资金操作前后校验。
--
-- 零回填:存量账户当前已满足 pending = 0 的两项式(wallet 与 openDebt 互为相反数),
-- 插入任何历史行都会立即破坏不变量。这张表只从新的大额充值开始积累。
-- 整段放进事务并带 lock_timeout:仓库门禁 check-migration-lock-timeout.mjs 要求
-- 任何取 ACCESS EXCLUSIVE / SHARE 级表锁的 DDL 自带 lock_timeout。
-- 这里的两个 CREATE INDEX 建在同事务刚创建的空表上、实际零竞争,但门禁不区分场景 ——
-- 它的存在理由是 2026-09-01 两地 prod 发版:裸 DDL 拿不到锁时无限等待,
-- 并把 ACCESS EXCLUSIVE 顶在锁队列队首,users 表后续所有新查询排在其后堵了 12 分钟。
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "balance_debt_settlement_pending" (
    "id" TEXT NOT NULL,
    "billing_account_id" TEXT NOT NULL,
    "allocation_source" TEXT NOT NULL,
    -- 无外键:与 gateway_usage_unreserved_queue 同一权衡 —— 这几列不加约束,
    -- 由 worker 侧重新校验账户/交易归属,避免只信队列侧在脏数据下错误核销。
    "repayment_transaction_id" TEXT NOT NULL,
    "balance_grant_id" TEXT,
    "remaining_paid_usd" DECIMAL(20,12) NOT NULL,
    "remaining_bonus_usd" DECIMAL(20,12) NOT NULL,
    -- 守恒触发器要求 settlement.occurred_at 严格等于 repayment transaction 的 created_at,
    -- 故在入队时固化,worker 不得改用自己的时钟。
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_debt_settlement_pending_pkey" PRIMARY KEY ("id"),

    -- 归零即删:不允许留下 remaining=0 的僵尸行。若允许,worker 的
    -- 「还有 pending 吗」判定就要额外区分零行,而不变量里的 Σ 又恰好不受影响
    -- ⇒ 一条被漏删的零行会静默变成永不收敛的循环。
    CONSTRAINT "balance_debt_settlement_pending_amounts_valid" CHECK (
        "remaining_paid_usd" >= 0
        AND "remaining_bonus_usd" >= 0
        AND "remaining_paid_usd" + "remaining_bonus_usd" > 0
    ),
    CONSTRAINT "balance_debt_settlement_pending_source_valid" CHECK (
        "allocation_source" IN ('ENTERPRISE_CREDIT', 'NEGATIVE_BALANCE')
    )
);

-- snapshot 三项式按 (账户, source) 聚合 pending
CREATE INDEX "balance_debt_settlement_pending_account_source_idx"
    ON "balance_debt_settlement_pending" ("billing_account_id", "allocation_source");

-- worker 按 FIFO 取待处理行(配合 FOR UPDATE SKIP LOCKED 支持多副本并发)
CREATE INDEX "balance_debt_settlement_pending_fifo_idx"
    ON "balance_debt_settlement_pending" ("created_at", "id");

COMMIT;
