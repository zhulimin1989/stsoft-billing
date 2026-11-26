-- R6 终态负额结算（自营 TokenPlan）：放宽 quota 维度允许为负，bonus/version/attempts 保持非负。
-- 与金额侧 allowTerminalSettlement 口径对齐——已交付的末笔可跨零完整入账，欠额落 quota 池。
-- INTEGER 列本身即 [-2147483648, 2147483647]，无需显式下界；此处仅重建 CHECK 移除 quota>=0。
-- 纯约束重建、无数据变更，秒级、可重入。

ALTER TABLE "credit_balance_states"
  DROP CONSTRAINT IF EXISTS "credit_balance_states_nonnegative";
ALTER TABLE "credit_balance_states"
  ADD CONSTRAINT "credit_balance_states_nonnegative"
  CHECK ("bonus" >= 0 AND "version" >= 0);

ALTER TABLE "credit_balance_outbox"
  DROP CONSTRAINT IF EXISTS "credit_balance_outbox_snapshot_nonnegative";
ALTER TABLE "credit_balance_outbox"
  ADD CONSTRAINT "credit_balance_outbox_snapshot_nonnegative"
  CHECK (
    "bonus" >= 0
    AND "version" >= 0
    AND "attempts" >= 0
    AND "max_attempts" > 0
  );
