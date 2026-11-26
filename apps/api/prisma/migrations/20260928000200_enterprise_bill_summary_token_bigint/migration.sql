-- 单月 token 合计可超过 INT4（造数/千万级用量）。
-- ALTER TYPE 取 ACCESS EXCLUSIVE，必须限制等锁时间。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "enterprise_bill_month_summaries"
  ALTER COLUMN "token_total" SET DATA TYPE BIGINT,
  ALTER COLUMN "request_count" SET DATA TYPE BIGINT;

ALTER TABLE "enterprise_bill_deadlines"
  ALTER COLUMN "frozen_token_total" SET DATA TYPE BIGINT,
  ALTER COLUMN "frozen_request_count" SET DATA TYPE BIGINT;

COMMIT;
