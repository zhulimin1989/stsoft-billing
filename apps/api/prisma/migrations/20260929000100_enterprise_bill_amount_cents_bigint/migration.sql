-- 单月金额可超过 INT4（2^31-1 分 = 2147 万元）。与 token_total 升 BIGINT 同因。
-- ALTER TYPE 取 ACCESS EXCLUSIVE，必须限制等锁时间。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "enterprise_bill_events"
  ALTER COLUMN "amount_cents" SET DATA TYPE BIGINT;

ALTER TABLE "enterprise_bill_deadlines"
  ALTER COLUMN "frozen_consume_cents" SET DATA TYPE BIGINT,
  ALTER COLUMN "frozen_voucher_cents" SET DATA TYPE BIGINT,
  ALTER COLUMN "frozen_charge_cents" SET DATA TYPE BIGINT;

ALTER TABLE "enterprise_bill_month_summaries"
  ALTER COLUMN "paid_cents" SET DATA TYPE BIGINT,
  ALTER COLUMN "pending_cents" SET DATA TYPE BIGINT,
  ALTER COLUMN "adjusted_cents" SET DATA TYPE BIGINT,
  ALTER COLUMN "issued_voucher_cents" SET DATA TYPE BIGINT,
  ALTER COLUMN "consume_cents" SET DATA TYPE BIGINT,
  ALTER COLUMN "voucher_cents" SET DATA TYPE BIGINT,
  ALTER COLUMN "charge_cents" SET DATA TYPE BIGINT;

COMMIT;
