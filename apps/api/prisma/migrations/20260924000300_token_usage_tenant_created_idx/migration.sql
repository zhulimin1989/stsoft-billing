-- 账单 tab live-usage：按工作区 + 时间窗月汇总 token_usage。
-- 单列 tenant_id 只能摸到该工作区全部行再滤时间；复合索引让
-- WHERE tenant_id = $id AND created_at >= $start AND created_at < $end
-- 只扫该工作区时间范围内的叶。
-- 大表建索引取 SHARE 锁；拿不到锁 5s 失败。statement_timeout 放宽以免建到一半被掐。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

CREATE INDEX IF NOT EXISTS "token_usage_tenant_id_created_at_idx"
  ON "token_usage" ("tenant_id", "created_at");

COMMIT;
