-- List 未结清：只扫「未完成分类且未结清」的 ENTERPRISE_CREDIT 行，
-- 不再对账户下全部信用分摊做 SUM。金额走已有
-- balance_allocations_account_funding_open_idx（approved/unapproved > 0）。
-- CREATE INDEX 取 SHARE 锁；拿不到锁 5s 失败。建索引本身可能超过 30s。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

CREATE INDEX IF NOT EXISTS "balance_allocations_enterprise_credit_incomplete_idx"
  ON "balance_consumption_allocations" ("billing_account_id")
  WHERE "source" = 'ENTERPRISE_CREDIT'
    AND "funding_classification_complete" IS NOT TRUE
    AND "settled_at" IS NULL;

COMMIT;
